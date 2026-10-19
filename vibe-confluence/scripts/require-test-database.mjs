import process from "node:process";
import { URL } from "node:url";

const value = process.env.TEST_DATABASE_URL;

if (!value) {
  throw new Error("TEST_DATABASE_URL is required for database load tests");
}

const databaseName = new URL(value).pathname.slice(1);
if (!databaseName.endsWith("_test")) {
  throw new Error("Load tests require a database name ending in _test");
}
