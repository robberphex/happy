import { ToolDefinition, ToolHandler } from "../agent/types"
import { LarkClient } from "./client"

const ToolRegistration = { definition: ToolDefinition; handler: ToolHandler }

export function createDocTools(larkClient) {
  return [createReadDocTool(larkClient), createAppendDocTool(larkClient)]
}

function createReadDocTool(larkClient) {
  const definition = {
    name: "read_lark_doc",
    description: "Read the plain text content of a Feishu (Lark) document by its token.",
    inputSchema: {
      type: "object",
      properties: {
        doc_token: {
          type: "string",
          description: "The document token (document_id) to read.",
        },
      },
      required: ["doc_token"],
    },
  }

  const handler = async (request) => {
    const docToken = request.arguments?.doc_token
    if (!docToken) {
      return { error: "doc_token is required" }
    }
    const content = await larkClient.fetchDocContent(docToken)
    if (content === null) {
      return { error: "Failed to read document or document not found" }
    }
    return { content }
  }

  return { definition, handler }
}

function createAppendDocTool(larkClient) {
  const definition = {
    name: "append_lark_doc",
    description: "Append a text block to the end of a Feishu (Lark) document.",
    inputSchema: {
      type: "object",
      properties: {
        doc_token: {
          type: "string",
          description: "The document token (document_id) to append to.",
        },
        content: {
          type: "string",
          description: "The text content to append.",
        },
      },
      required: ["doc_token", "content"],
    },
  }

  const handler = async (request) => {
    const docToken = request.arguments?.doc_token
    const content = request.arguments?.content
    if (!docToken || !content) {
      return { error: "doc_token and content are required" }
    }
    const ok = await larkClient.appendDocContent(docToken, content)
    return ok ? { success: true } : { error: "Failed to append content to document" }
  }

  return { definition, handler }
}
