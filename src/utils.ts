/*
Utility functions for JSON path navigation and credential validation.
*/
import { UNAME, PASSWD } from "./constants.js";

export function hasNestedProperty(obj: object, path: string): boolean {
  return (
    path.split(".").reduce((acc, key) => {
      if (
        acc &&
        (typeof acc === "object" || Array.isArray(acc)) &&
        key in acc
      ) {
        return acc[key];
      }
      return undefined;
    }, obj) !== undefined
  );
}
export function getNestedValue(obj: object, path: string): unknown {
  return path.split(".").reduce((acc, key) => {
    if (acc && (typeof acc === "object" || Array.isArray(acc))) {
      return acc[key];
    }
    return undefined;
  }, obj);
}
export function isValidBody(body: object): boolean {
  const hasBody = body !== null && typeof body === "object";
  const hasCredentials =
    hasBody &&
    hasNestedProperty(body, UNAME) &&
    hasNestedProperty(body, PASSWD);
  const username = hasBody ? getNestedValue(body, UNAME) : undefined;
  const password = hasBody ? getNestedValue(body, PASSWD) : undefined;
  const bodyIsValid =
    hasCredentials &&
    typeof username === "string" &&
    typeof password === "string" &&
    username.length > 1 &&
    password.length > 2;
  return bodyIsValid;
}
