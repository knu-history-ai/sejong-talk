// Node 24: launch the PR97 server with --conditions=react-server.
import { createBedrockAnswer } from "../../src/server/ai/bedrock-answer.ts";
export const answer = createBedrockAnswer({ log: (event) => console.info(JSON.stringify(event)) });
