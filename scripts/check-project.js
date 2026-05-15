import { access } from "node:fs/promises";

const required = [
  "public/index.html",
  "public/styles.css",
  "public/app.js",
  "netlify/functions/translate.js",
];

await Promise.all(required.map((file) => access(file)));
console.log("Project files are in place.");
