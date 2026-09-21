#!/usr/bin/env node

import { MUTATION_GATE_CI_MESSAGE, mutationGateAllowed } from "./mutation-gate-runtime.mjs";

if (!mutationGateAllowed()) {
  process.stderr.write(`${MUTATION_GATE_CI_MESSAGE}\n`);
  process.exit(2);
}
