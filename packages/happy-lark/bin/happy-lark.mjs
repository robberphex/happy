#!/usr/bin/env node

import { HappyClient } from "../src/happy/HappyClient.mjs";
import { LarkClient } from "../src/lark/client.mjs";
import { Orchestrator } from "../src/orchestrator/Orchestrator.mjs";
import { createLogger } from "../src/utils/logger.mjs";

const larkClient = new LarkClient(
  {
    appId: process.env.LARK_APP_ID,
    appSecret: process.env.LARK_APP_SECRET,
    domain: process.env.LARK_DOMAIN,
    encryptKey: process.env.LARK_ENCRYPT_KEY,
  },
  createLogger('larkClient'),
);

const hClient = new HappyClient();

const orch = new Orchestrator(larkClient, hClient);

await orch.startApi();
