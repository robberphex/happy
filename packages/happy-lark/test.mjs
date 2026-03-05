import { HappyClient } from "./src/happy/HappyClient.mjs";
import { LarkClient } from "./src/lark/client.mjs";

// const larkClient = new LarkClient(
//     {
//         appId: "cli_a9285e66e1f81bd9",
//         appSecret: "peSZH8M1z5ddL12YOxVuddVTiqj4E1nS",
//     }
// );
// larkClient.sendTextByUserOpenId("ou_4749e5cc8e75ed38c97a70af20309727","test1");

const hClient = new HappyClient();

const secret = await hClient.getRandomBytesAsync(32);
console.log(secret);
const token = await hClient.authGetToken(secret);
console.log(token);
