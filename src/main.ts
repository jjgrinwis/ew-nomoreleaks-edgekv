/*
(c) Copyright 2024 Akamai Technologies, Inc. Licensed under Apache 2 license.
Purpose: EdgeWorker that checks username/password hashes against the
         leaked-credential list held in EdgeKV, and tells origin the verdict.

Required configuration:
- vendor/edgekv_tokens.js must hold a read-only token for the EdgeKV namespace
- Update constants.ts for field mappings and the EdgeKV namespace/group
*/
import { httpRequest } from "http-request";
import { createResponse } from "create-response";
import { generateDigest } from "./generateDigest.js";
import URLSearchParams from "url-search-params";
import { logger } from "log";

import { isValidBody, getNestedValue } from "./utils.js";
import { isKnownLeaked, LookupStatus } from "./knownKey.js";
import { UNAME, PASSWD, NO_MORE_LEAKS_HEADER } from "./constants.js";

export async function responseProvider(request: EW.ResponseProviderRequest) {
  const contentType = request.getHeader("content-type")?.[0]?.toLowerCase();

  let body: object | null = null;
  let formBody: string | null = null;

  if (contentType) {
    try {
      if (contentType.startsWith("application/json")) {
        body = await request.json();
      } else if (contentType.startsWith("application/x-www-form-urlencoded")) {
        formBody = await request.text();
        const params = new URLSearchParams(formBody);
        body = mapCredentials(params);
      }
    } catch (error) {
      logger.error(
        `Failed to parse request body with Content-Type: ${contentType}`,
        error,
      );
    }
  } else {
    logger.error("Content-Type is undefined, skipped parsing.");
  }

  let key: string | undefined = undefined;
  let known = false;
  // "nocreds" = this request carried no credentials, so there was nothing to check.
  // Kept distinct from "ok" so the logs do not conflate it with a clean password.
  let status: LookupStatus | "nocreds" = "nocreds";

  if (body && isValidBody(body)) {
    try {
      const username = getNestedValue(body, UNAME);
      const password = getNestedValue(body, PASSWD);
      if (typeof username !== "string" || typeof password !== "string") {
        throw new TypeError("credential fields must be strings");
      }
      const normalizedUnamePasswd =
        username.toLowerCase().normalize("NFC") + password.normalize("NFC");

      key = await generateDigest("SHA-256", normalizedUnamePasswd);
    } catch (error) {
      logger.error(`Failed to create SHA-256 hash: ${error}`);
    }

    if (key) {
      const result = await isKnownLeaked(key);
      known = result.known;
      status = result.status;
    } else {
      status = "unavailable";
    }
  } else {
    logger.error(
      `${UNAME} and/or ${PASSWD} fields not provided in request body`,
    );
  }

  // The only per-check telemetry, and the source of hit statistics.
  // Deliberately carries no hash, no hash prefix, no username and no client IP.
  logger.log(JSON.stringify({ ev: "check", known: known, st: status }));

  const reqBody = formBody || JSON.stringify(body);

  let originResponse;
  try {
    originResponse = await originRequest(request, reqBody, known);
  } catch (error) {
    // Without this the rejection escapes responseProvider and fails the login outright.
    logger.error(`Failed origin sub-request: ${error}`);
    return createResponse(502, {}, "Bad Gateway");
  }

  return createResponse(
    originResponse.status,
    removeUnsafeHeaders(originResponse.getHeaders()),
    originResponse.body,
  );
}

async function originRequest(
  request: EW.ResponseProviderRequest,
  body: string,
  known: boolean,
  informHeader: string = NO_MORE_LEAKS_HEADER,
) {
  let requestHeaders = removeUnsafeHeaders(request.getHeaders());

  requestHeaders[informHeader] = [String(known)];

  const originResponse = await httpRequest(request.url, {
    method: request.method,
    headers: requestHeaders,
    body: body,
  });

  return originResponse;
}

function mapCredentials(params: URLSearchParams): { [key: string]: string } {
  return {
    [UNAME]: params.get(UNAME) || "",
    [PASSWD]: params.get(PASSWD) || "",
  };
}

function removeUnsafeHeaders(headers: EW.Headers): EW.Headers {
  const HEADERS_TO_REMOVE = [
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "vary",
    "accept-encoding",
    "content-encoding",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "upgrade",
  ];

  if (headers && typeof headers === "object") {
    HEADERS_TO_REMOVE.forEach((header) => delete headers[header.toLowerCase()]);
  }

  return headers;
}
