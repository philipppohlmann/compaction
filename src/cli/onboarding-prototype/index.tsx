#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import { parseScenario } from "./model.js";

const scenarioFlag = process.argv.indexOf("--scenario");
const scenario = parseScenario(scenarioFlag >= 0 ? process.argv[scenarioFlag + 1] : undefined);

async function main(): Promise<void> {
  const app = render(<App scenario={scenario} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
}

await main();
