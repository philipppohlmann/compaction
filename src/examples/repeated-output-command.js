const repeatedLine =
  "demo repeated output: deterministic local capture line with synthetic fixture data and no secrets, repeated to exercise stale tool output compaction";

console.log("demo command started");
console.log("demo unique output: preparing compaction artifact verification");

for (let index = 1; index <= 20; index += 1) {
  console.log(repeatedLine);
}

console.error("demo stderr: warning stream captured locally");
console.log("demo command finished");
