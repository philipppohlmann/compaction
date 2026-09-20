/**
 * Pure, content-free census of request input components.
 *
 * Exact component sizes use the component VALUE: decoded strings are counted as their values;
 * object and array values use JSON.stringify(value), including the keys and punctuation inside that
 * component. Only surrounding request-envelope keys and punctuation are outside this basis, so
 * these totals are not provider prompt-token counts. The local estimate is Unicode
 * code points / 4, rounded to the nearest integer. Opaque, encrypted, redacted, unclassified, and
 * server-referenced values are never estimated. A recognized plaintext `thinking` string may be
 * estimated; the presence of a signature or opaque descendant makes its whole block unavailable.
 * A request containing a structured value that exceeds the bounded safety walk or cannot be
 * serialized falls back to one content-free root component measured from the exact raw request.
 * Caller-provided object keys and unknown type labels are never returned.
 */

export type RequestProtocol = "anthropic-messages" | "openai-responses" | "openai-chat" | "unknown";
export type InputCategory =
  | "instructions"
  | "conversation"
  | "active_input"
  | "tool_definition"
  | "tool_call"
  | "tool_result"
  | "other_prompt"
  | "opaque_nontext"
  | "transport_control"
  | "unclassified";
export type PromptDisposition = "included" | "excluded" | "unknown";

export interface RequestInputCensusOptions {
  /** Exact component paths that the caller has independently identified as the active input. */
  activeInputPaths?: readonly string[];
}

export interface ComponentSize {
  utf8Bytes: number;
  unicodeCodePoints: number;
}

export type ComponentEstimate =
  | { kind: "local_estimate"; estimatorId: "unicode-code-points-div-4-v1"; tokens: number }
  | {
      kind: "unavailable";
      reason: "opaque_or_nontext" | "unclassified" | "not_prompt_input" | "measurement_limit";
    };

export interface RequestInputComponent {
  path: string;
  category: InputCategory;
  type: string;
  promptDisposition: PromptDisposition;
  exact: ComponentSize;
  estimate: ComponentEstimate;
}

export interface RequestInputCensus {
  protocol: RequestProtocol;
  parsed: boolean;
  basis: "canonical_component_values_v1" | "raw_request_fallback_v1";
  source: ComponentSize;
  components: RequestInputComponent[];
  totals: {
    componentValues: ComponentSize;
    promptIncluded: ComponentSize;
    transportExcluded: ComponentSize;
    promptUnknown: ComponentSize;
    localEstimate: {
      kind: "local_estimate";
      estimatorId: "unicode-code-points-div-4-v1";
      tokens: number;
      coveredCodePoints: number;
      eligibleCodePoints: number;
      coverage: number | null;
    };
  };
}

const ESTIMATOR_ID = "unicode-code-points-div-4-v1" as const;
const MEDIA_TYPES = new Set([
  "image",
  "input_image",
  "audio",
  "input_audio",
  "document",
  "file",
  "input_file",
  "encrypted_content",
  "redacted_thinking",
  "item_reference"
]);

function sizeOf(text: string): ComponentSize {
  return { utf8Bytes: Buffer.byteLength(text, "utf8"), unicodeCodePoints: Array.from(text).length };
}

function canonicalValue(value: unknown): { text: string; available: boolean } {
  if (value === undefined) return { text: "", available: true };
  if (typeof value === "string") return { text: value, available: true };
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? { text: "", available: false } : { text: serialized, available: true };
  } catch {
    return { text: "", available: false };
  }
}

function pathKey(base: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

function pathIndex(base: string, index: number): string {
  return `${base}[${index}]`;
}

function protocolFor(endpoint: string): RequestProtocol {
  const path = endpoint.split("?", 1)[0];
  if (path.endsWith("/chat/completions")) return "openai-chat";
  if (path.endsWith("/responses")) return "openai-responses";
  if (path.endsWith("/messages")) return "anthropic-messages";
  return "unknown";
}

export function censusRequestInput(
  endpoint: string,
  bodyText: string,
  options: RequestInputCensusOptions = {}
): RequestInputCensus {
  const protocol = protocolFor(endpoint);
  const activePaths = new Set(options.activeInputPaths ?? []);
  const components: RequestInputComponent[] = [];
  let measurementLimited = false;

  const add = (
    path: string,
    value: unknown,
    category: InputCategory,
    type: string,
    disposition: PromptDisposition,
    estimate: "available" | "opaque" | "unclassified" | "unserializable" = "available"
  ): void => {
    const canonical = estimate === "unserializable" ? { text: "", available: false } : canonicalValue(value);
    if (!canonical.available) measurementLimited = true;
    const exact = sizeOf(canonical.text);
    const componentEstimate: ComponentEstimate =
      !canonical.available
        ? { kind: "unavailable", reason: "measurement_limit" }
        : disposition === "excluded"
        ? { kind: "unavailable", reason: "not_prompt_input" }
        : estimate === "available"
          ? {
              kind: "local_estimate",
              estimatorId: ESTIMATOR_ID,
              tokens: Math.round(exact.unicodeCodePoints / 4)
            }
          : { kind: "unavailable", reason: estimate === "opaque" ? "opaque_or_nontext" : "unclassified" };
    components.push({ path, category, type, promptDisposition: disposition, exact, estimate: componentEstimate });
  };

  const addText = (path: string, value: unknown, role: string): void => {
    if (typeof value !== "string") {
      add(path, value, "unclassified", "malformed_text", "unknown", "unclassified");
      return;
    }
    const category: InputCategory =
      role === "system" || role === "developer"
        ? "instructions"
        : activePaths.has(path)
          ? "active_input"
          : "conversation";
    add(path, value, category, "text", "included");
  };

  const addToolCall = (path: string, value: unknown, type: string): void => {
    const opaque = opaqueTraversal(value);
    add(
      path,
      value,
      "tool_call",
      type,
      "included",
      opaque === "limit" ? "unserializable" : opaque === "opaque" ? "opaque" : "available"
    );
  };

  const addToolResultContent = (path: string, value: unknown): void => {
    if (typeof value === "string") {
      add(path, value, "tool_result", "tool_result_text", "included");
      return;
    }
    if (!Array.isArray(value)) {
      add(path, value, "unclassified", "malformed_tool_result", "unknown", "unclassified");
      return;
    }
    value.forEach((part, index) => {
      const partPath = pathIndex(path, index);
      if (!isRecord(part) || typeof part.type !== "string") {
        add(partPath, part, "unclassified", "malformed_tool_result_part", "unknown", "unclassified");
      } else if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
        if (typeof part.text === "string") add(pathKey(partPath, "text"), part.text, "tool_result", "tool_result_text", "included");
        else add(pathKey(partPath, "text"), part.text, "unclassified", "malformed_tool_result_text", "unknown", "unclassified");
        add(pathKey(partPath, "type"), part.type, "transport_control", "block_type", "excluded");
        addUnknownValues(part, partPath, new Set(["type", "text"]), add);
      } else if (MEDIA_TYPES.has(part.type)) {
        add(partPath, part, "opaque_nontext", part.type, "included", "opaque");
      } else if (part.type.startsWith("server_")) {
        add(partPath, part, "opaque_nontext", "opaque_tool_result_part", "included", "opaque");
      } else {
        const opaque = opaqueTraversal(part);
        if (opaque !== "clear") {
          add(
            partPath,
            part,
            "opaque_nontext",
            "opaque_tool_result_part",
            "included",
            opaque === "limit" ? "unserializable" : "opaque"
          );
        } else {
          add(partPath, part, "unclassified", "unknown_tool_result_part", "unknown", "unclassified");
        }
      }
    });
  };

  const addToolResultBlock = (path: string, block: Record<string, unknown>, contentKey: "content" | "output"): void => {
    add(pathKey(path, "type"), block.type, "transport_control", "block_type", "excluded");
    for (const key of ["tool_use_id", "call_id", "id", "is_error"] as const) {
      if (key in block) add(pathKey(path, key), block[key], "transport_control", "tool_result_metadata", "excluded");
    }
    if (contentKey in block) addToolResultContent(pathKey(path, contentKey), block[contentKey]);
    else add(pathKey(path, contentKey), undefined, "unclassified", `missing_${contentKey}`, "unknown", "unclassified");
    addUnknownValues(block, path, new Set(["type", "tool_use_id", "call_id", "id", "is_error", contentKey]), add);
  };

  const addContent = (path: string, content: unknown, role: string): void => {
    if (role === "tool" || role === "function") {
      addToolResultContent(path, content);
      return;
    }
    if (content === null) {
      add(path, content, "transport_control", "empty_content", "excluded");
      return;
    }
    if (typeof content === "string") {
      addText(path, content, role);
      return;
    }
    if (!Array.isArray(content)) {
      add(path, content, "unclassified", "malformed_content", "unknown", "unclassified");
      return;
    }
    content.forEach((block, index) => {
      const blockPath = pathIndex(path, index);
      if (!isRecord(block) || typeof block.type !== "string") {
        add(blockPath, block, "unclassified", "malformed_block", "unknown", "unclassified");
        return;
      }
      const type = block.type;
      if (type === "text" || type === "input_text" || type === "output_text") {
        addText(pathKey(blockPath, "text"), block.text, role);
        add(pathKey(blockPath, "type"), type, "transport_control", "block_type", "excluded");
        addUnknownValues(block, blockPath, new Set(["type", "text"]), add);
      } else if (TOOL_CALL_TYPES.has(type)) {
        addToolCall(blockPath, block, type);
      } else if (type === "tool_result" || type === "function_call_output") {
        addToolResultBlock(blockPath, block, type === "tool_result" ? "content" : "output");
      } else if (type === "thinking") {
        const opaque = opaqueTraversal(block);
        if (opaque !== "clear" || "signature" in block) {
          add(
            blockPath,
            block,
            "other_prompt",
            "thinking",
            "included",
            opaque === "limit" ? "unserializable" : "opaque"
          );
        } else {
          if ("thinking" in block && typeof block.thinking === "string") {
            add(pathKey(blockPath, "thinking"), block.thinking, "other_prompt", "thinking_text", "included");
          } else {
            add(pathKey(blockPath, "thinking"), undefined, "unclassified", "missing_thinking", "unknown", "unclassified");
          }
          add(pathKey(blockPath, "type"), type, "transport_control", "block_type", "excluded");
          addUnknownValues(block, blockPath, new Set(["type", "thinking"]), add);
        }
      } else if (type === "reasoning") {
        add(blockPath, block, "unclassified", "reasoning_item", "unknown", "unclassified");
      } else if (MEDIA_TYPES.has(type) || type.startsWith("server_")) {
        add(blockPath, block, "opaque_nontext", type.startsWith("server_") ? "server_reference" : type, "included", "opaque");
      } else {
        add(blockPath, block, "unclassified", "unknown_block_type", "unknown", "unclassified");
      }
    });
  };

  const addTools = (value: unknown, path: string): void => {
    if (!Array.isArray(value)) {
      add(path, value, "unclassified", "malformed_tools", "unknown", "unclassified");
      return;
    }
    value.forEach((tool, index) => addToolDefinition(pathIndex(path, index), tool));
  };

  const addToolDefinition = (path: string, tool: unknown): void => {
    if (!isRecord(tool)) {
      add(path, tool, "unclassified", "malformed_tool_definition", "unknown", "unclassified");
      return;
    }
    const deferred = tool.defer_loading;
    if (deferred !== undefined && typeof deferred !== "boolean") {
      add(path, tool, "unclassified", "invalid_tool_defer_loading", "unknown", "unclassified");
      return;
    }
    add(
      path,
      tool,
      "tool_definition",
      deferred === true ? "tool_definition_deferred" : "tool_definition_direct",
      "included"
    );
  };

  const addAdditionalTools = (path: string, item: Record<string, unknown>): void => {
    if (!isStrictAdditionalTools(item)) {
      add(path, item, "unclassified", "malformed_additional_tools", "unknown", "unclassified");
      return;
    }
    addControl(pathKey(path, "type"), item.type, "item_type");
    addControl(pathKey(path, "role"), item.role, "role");
    if ("id" in item) addControl(pathKey(path, "id"), item.id, "tool_definition_metadata");
    item.tools.forEach((tool, index) => {
      const toolPath = pathIndex(pathKey(path, "tools"), index);
      add(pathKey(toolPath, "type"), tool.type, "tool_definition", "tool_namespace_type", "included");
      add(pathKey(toolPath, "name"), tool.name, "tool_definition", "tool_namespace_name", "included");
      if (tool.description !== undefined) {
        add(pathKey(toolPath, "description"), tool.description, "tool_definition", "tool_namespace_description", "included");
      }
      tool.tools.forEach((nested, nestedIndex) =>
        addToolDefinition(pathIndex(pathKey(toolPath, "tools"), nestedIndex), nested)
      );
    });
  };

  const addToolSearchOutput = (path: string, item: Record<string, unknown>): void => {
    if (!isStrictToolSearchOutput(item)) {
      add(path, item, "unclassified", "malformed_tool_search_output", "unknown", "unclassified");
      return;
    }
    for (const key of ["type", "execution", "status", "call_id", "id", "internal_chat_message_metadata_passthrough"] as const) {
      if (key in item) addControl(pathKey(path, key), item[key], key === "type" ? "item_type" : "tool_result_metadata");
    }
    add(pathKey(path, "tools"), item.tools, "tool_result", "tool_search_result", "included");
  };

  const addControl = (path: string, value: unknown, type = "control"): void =>
    add(path, value, "transport_control", type, "excluded");
  const source = sizeOf(bodyText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return rawRequestFallback(protocol, false, source, "invalid_json", "unclassified");
  }
  if (!isRecord(parsed) || protocol === "unknown") {
    return rawRequestFallback(
      protocol,
      true,
      source,
      protocol === "unknown" ? "unknown_endpoint" : "non_object_body",
      "unclassified"
    );
  }

  if (protocol === "openai-responses") {
    const consumed = new Set<string>();
    if ("instructions" in parsed) {
      consumed.add("instructions");
      addText("$.instructions", parsed.instructions, "system");
    }
    if ("input" in parsed) {
      consumed.add("input");
      if (typeof parsed.input === "string") addText("$.input", parsed.input, "user");
      else if (Array.isArray(parsed.input)) {
        parsed.input.forEach((item, index) =>
          censusResponsesItem(
            item,
            pathIndex("$.input", index),
            add,
            addContent,
            addText,
            addControl,
            addToolCall,
            addToolResultBlock,
            addAdditionalTools,
            addToolSearchOutput
          )
        );
      } else add("$.input", parsed.input, "unclassified", "malformed_input", "unknown", "unclassified");
    }
    if ("tools" in parsed) {
      consumed.add("tools");
      addTools(parsed.tools, "$.tools");
    }
    if ("previous_response_id" in parsed) {
      consumed.add("previous_response_id");
      add("$.previous_response_id", parsed.previous_response_id, "opaque_nontext", "server_response_reference", "included", "opaque");
    }
    for (const key of RESPONSE_CONTROL_FIELDS) {
      if (key in parsed) {
        consumed.add(key);
        addControl(pathKey("$", key), parsed[key]);
      }
    }
    addUnknownValues(parsed, "$", consumed, add);
  } else {
    const anthropic = protocol === "anthropic-messages";
    const consumed = new Set<string>();
    if (anthropic && "system" in parsed) {
      consumed.add("system");
      addContent("$.system", parsed.system, "system");
    }
    if ("messages" in parsed) {
      consumed.add("messages");
      if (Array.isArray(parsed.messages)) {
        parsed.messages.forEach((message, index) => {
          const messagePath = pathIndex("$.messages", index);
          const validRoles = anthropic ? ANTHROPIC_MESSAGE_ROLES : CHAT_MESSAGE_ROLES;
          if (!isRecord(message)) {
            add(messagePath, message, "unclassified", "malformed_message", "unknown", "unclassified");
            return;
          }
          if (!("role" in message)) {
            add(pathKey(messagePath, "role"), undefined, "unclassified", "missing_role", "unknown", "unclassified");
            if ("content" in message) add(pathKey(messagePath, "content"), message.content, "unclassified", "unclassified_content", "unknown", "unclassified");
            addUnknownValues(message, messagePath, new Set(["role", "content"]), add);
            return;
          }
          if (typeof message.role !== "string" || !validRoles.has(message.role)) {
            add(pathKey(messagePath, "role"), message.role, "unclassified", "invalid_role", "unknown", "unclassified");
            if ("content" in message) add(pathKey(messagePath, "content"), message.content, "unclassified", "unclassified_content", "unknown", "unclassified");
            addUnknownValues(message, messagePath, new Set(["role", "content"]), add);
            return;
          }
          addControl(pathKey(messagePath, "role"), message.role, "role");
          if ("content" in message) addContent(pathKey(messagePath, "content"), message.content, message.role);
          if ("tool_calls" in message) {
            if (Array.isArray(message.tool_calls)) {
              message.tool_calls.forEach((call, callIndex) =>
                addToolCall(pathIndex(pathKey(messagePath, "tool_calls"), callIndex), call, "tool_call")
              );
            } else add(pathKey(messagePath, "tool_calls"), message.tool_calls, "unclassified", "malformed_tool_calls", "unknown", "unclassified");
          }
          if ("function_call" in message) {
            addToolCall(pathKey(messagePath, "function_call"), message.function_call, "function_call");
          }
          if ("tool_call_id" in message) addControl(pathKey(messagePath, "tool_call_id"), message.tool_call_id);
          if ("name" in message) addControl(pathKey(messagePath, "name"), message.name);
          if ("refusal" in message) add(pathKey(messagePath, "refusal"), message.refusal, "other_prompt", "refusal", "included");
          const known = new Set(["role", "content", "tool_calls", "function_call", "tool_call_id", "name", "refusal"]);
          addUnknownValues(message, messagePath, known, add);
        });
      } else add("$.messages", parsed.messages, "unclassified", "malformed_messages", "unknown", "unclassified");
    }
    if ("tools" in parsed) {
      consumed.add("tools");
      addTools(parsed.tools, "$.tools");
    }
    for (const key of anthropic ? ANTHROPIC_CONTROL_FIELDS : CHAT_CONTROL_FIELDS) {
      if (key in parsed) {
        consumed.add(key);
        addControl(pathKey("$", key), parsed[key]);
      }
    }
    addUnknownValues(parsed, "$", consumed, add);
  }
  return measurementLimited
    ? rawRequestFallback(protocol, true, source, "measurement_limit", "measurement_limit")
    : finish(protocol, true, source, components);
}

type Add = (
  path: string,
  value: unknown,
  category: InputCategory,
  type: string,
  disposition: PromptDisposition,
  estimate?: "available" | "opaque" | "unclassified" | "unserializable"
) => void;

function censusResponsesItem(
  item: unknown,
  path: string,
  add: Add,
  addContent: (path: string, content: unknown, role: string) => void,
  addText: (path: string, value: unknown, role: string) => void,
  addControl: (path: string, value: unknown, type?: string) => void,
  addToolCall: (path: string, value: unknown, type: string) => void,
  addToolResultBlock: (path: string, block: Record<string, unknown>, contentKey: "content" | "output") => void,
  addAdditionalTools: (path: string, item: Record<string, unknown>) => void,
  addToolSearchOutput: (path: string, item: Record<string, unknown>) => void
): void {
  if (!isRecord(item) || typeof item.type !== "string") {
    add(path, item, "unclassified", "malformed_input_item", "unknown", "unclassified");
    return;
  }
  if (item.type === "message") {
    if (!("role" in item)) {
      add(pathKey(path, "role"), undefined, "unclassified", "missing_role", "unknown", "unclassified");
      if ("content" in item) add(pathKey(path, "content"), item.content, "unclassified", "unclassified_content", "unknown", "unclassified");
    } else if (typeof item.role !== "string" || !RESPONSE_MESSAGE_ROLES.has(item.role)) {
      add(pathKey(path, "role"), item.role, "unclassified", "invalid_role", "unknown", "unclassified");
      if ("content" in item) add(pathKey(path, "content"), item.content, "unclassified", "unclassified_content", "unknown", "unclassified");
    } else {
      addControl(pathKey(path, "role"), item.role, "role");
      if ("content" in item) addContent(pathKey(path, "content"), item.content, item.role);
      else add(pathKey(path, "content"), undefined, "unclassified", "missing_content", "unknown", "unclassified");
    }
    addControl(pathKey(path, "type"), item.type, "item_type");
    addUnknownValues(item, path, new Set(["type", "role", "content"]), add);
  } else if (TOOL_CALL_TYPES.has(item.type)) {
    addToolCall(path, item, item.type);
  } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    addToolResultBlock(path, item, "output");
  } else if (item.type === "additional_tools") {
    addAdditionalTools(path, item);
  } else if (item.type === "tool_search_output") {
    addToolSearchOutput(path, item);
  } else if (MEDIA_TYPES.has(item.type) || item.type.startsWith("server_")) {
    add(path, item, "opaque_nontext", item.type.startsWith("server_") ? "server_reference" : item.type, "included", "opaque");
  } else if (item.type === "input_text") {
    addText(pathKey(path, "text"), item.text, "user");
    addControl(pathKey(path, "type"), item.type, "item_type");
    addUnknownValues(item, path, new Set(["type", "text"]), add);
  } else {
    add(path, item, "unclassified", item.type === "reasoning" ? "reasoning_item" : "unknown_item_type", "unknown", "unclassified");
  }
}

function addUnknownValues(obj: Record<string, unknown>, base: string, known: ReadonlySet<string>, add: Add): void {
  let unknownIndex = 0;
  for (const [key, value] of Object.entries(obj)) {
    if (!known.has(key)) {
      add(`${base}.unknown_fields[${unknownIndex}]`, value, "unclassified", "unknown_field", "unknown", "unclassified");
      unknownIndex++;
    }
  }
}

const ANTHROPIC_CONTROL_FIELDS = ["model", "max_tokens", "temperature", "top_p", "top_k", "stop_sequences", "stream", "metadata", "tool_choice"] as const;
const CHAT_CONTROL_FIELDS = ["model", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stream", "stream_options", "response_format", "tool_choice", "parallel_tool_calls", "metadata", "user", "seed", "n", "stop"] as const;
const RESPONSE_CONTROL_FIELDS = ["model", "max_output_tokens", "temperature", "top_p", "stream", "store", "metadata", "tool_choice", "parallel_tool_calls", "include", "reasoning", "text", "truncation"] as const;
const ANTHROPIC_MESSAGE_ROLES = new Set(["user", "assistant"]);
const CHAT_MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"]);
const RESPONSE_MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant"]);
const TOOL_CALL_TYPES = new Set([
  "tool_use",
  "function_call",
  "computer_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call",
  "tool_search_call",
  "image_generation_call"
]);

type StrictNamespaceLeafTool = Record<string, unknown> & {
  type: "custom" | "function";
  name: string;
};

type StrictDynamicNamespaceTool = Record<string, unknown> & {
  type: "namespace";
  name: string;
  description?: string;
  tools: StrictNamespaceLeafTool[];
};

type StrictAdditionalTools = Record<string, unknown> & {
  type: "additional_tools";
  id?: string | null;
  role: "developer";
  tools: StrictDynamicNamespaceTool[];
};

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStrictNamespaceLeafTool(value: unknown): value is StrictNamespaceLeafTool {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, NAMESPACE_LEAF_KEYS) &&
    (value.type === "custom" || value.type === "function") &&
    typeof value.name === "string"
  );
}

function isStrictDynamicNamespaceTool(value: unknown): value is StrictDynamicNamespaceTool {
  if (!isRecord(value) || !hasOnlyKeys(value, NAMESPACE_TOOL_KEYS)) return false;
  return (
    value.type === "namespace" &&
    typeof value.name === "string" &&
    (value.description === undefined || typeof value.description === "string") &&
    Array.isArray(value.tools) &&
    value.tools.every(isStrictNamespaceLeafTool)
  );
}

function isStrictAdditionalTools(value: Record<string, unknown>): value is StrictAdditionalTools {
  return (
    hasOnlyKeys(value, ADDITIONAL_TOOLS_KEYS) &&
    value.type === "additional_tools" &&
    (value.id === undefined || value.id === null || typeof value.id === "string") &&
    value.role === "developer" &&
    Array.isArray(value.tools) &&
    value.tools.every(isStrictDynamicNamespaceTool)
  );
}

function isStrictToolSearchOutput(value: Record<string, unknown>): value is Record<string, unknown> & {
  type: "tool_search_output";
  execution: string;
  status: string;
  tools: unknown[];
} {
  if (!hasOnlyKeys(value, TOOL_SEARCH_OUTPUT_KEYS)) return false;
  if (value.type !== "tool_search_output" || typeof value.execution !== "string" || typeof value.status !== "string") {
    return false;
  }
  if (!Array.isArray(value.tools)) return false;
  for (const key of ["call_id", "id"] as const) {
    if (key in value && value[key] !== null && typeof value[key] !== "string") return false;
  }
  return (
    !("internal_chat_message_metadata_passthrough" in value) ||
    value.internal_chat_message_metadata_passthrough === null ||
    isRecord(value.internal_chat_message_metadata_passthrough)
  );
}

const NAMESPACE_TOOL_KEYS = new Set(["type", "name", "description", "tools"]);
const NAMESPACE_LEAF_KEYS = new Set(["type", "name"]);
const ADDITIONAL_TOOLS_KEYS = new Set(["type", "id", "role", "tools"]);
const TOOL_SEARCH_OUTPUT_KEYS = new Set([
  "type",
  "execution",
  "status",
  "tools",
  "call_id",
  "id",
  "internal_chat_message_metadata_passthrough"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function opaqueTraversal(value: unknown): "clear" | "opaque" | "limit" {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  const maxNodes = 4096;
  let visited = 0;
  while (pending.length > 0) {
    if (visited >= maxNodes) return "limit";
    const current = pending.pop();
    visited++;
    if (typeof current !== "object" || current === null) continue;
    if (seen.has(current)) return "opaque";
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length + pending.length > maxNodes - visited) return "limit";
      for (const nested of current) pending.push(nested);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (typeof record.type === "string" && (MEDIA_TYPES.has(record.type) || record.type.startsWith("server_"))) {
      return "opaque";
    }
    const entries = Object.entries(record);
    if (entries.length + pending.length > maxNodes - visited) return "limit";
    for (const [key, nested] of entries) {
      if (key.toLowerCase().includes("encrypted") || key === "image_url") return "opaque";
      pending.push(nested);
    }
  }
  return "clear";
}

function sumSizes(components: readonly RequestInputComponent[]): ComponentSize {
  return components.reduce(
    (sum, component) => ({
      utf8Bytes: sum.utf8Bytes + component.exact.utf8Bytes,
      unicodeCodePoints: sum.unicodeCodePoints + component.exact.unicodeCodePoints
    }),
    { utf8Bytes: 0, unicodeCodePoints: 0 }
  );
}

function rawRequestFallback(
  protocol: RequestProtocol,
  parsed: boolean,
  source: ComponentSize,
  type: "invalid_json" | "unknown_endpoint" | "non_object_body" | "measurement_limit",
  reason: "unclassified" | "measurement_limit"
): RequestInputCensus {
  const component: RequestInputComponent = {
    path: "$",
    category: "unclassified",
    type,
    promptDisposition: "unknown",
    exact: { ...source },
    estimate: { kind: "unavailable", reason }
  };
  return {
    protocol,
    parsed,
    basis: "raw_request_fallback_v1",
    source,
    components: [component],
    totals: {
      componentValues: { ...source },
      promptIncluded: { utf8Bytes: 0, unicodeCodePoints: 0 },
      transportExcluded: { utf8Bytes: 0, unicodeCodePoints: 0 },
      promptUnknown: { ...source },
      localEstimate: {
        kind: "local_estimate",
        estimatorId: ESTIMATOR_ID,
        tokens: 0,
        coveredCodePoints: 0,
        eligibleCodePoints: source.unicodeCodePoints,
        coverage: source.unicodeCodePoints === 0 ? null : 0
      }
    }
  };
}

function finish(
  protocol: RequestProtocol,
  parsed: boolean,
  source: ComponentSize,
  components: RequestInputComponent[]
): RequestInputCensus {
  const included = components.filter((component) => component.promptDisposition === "included");
  const possiblyPrompt = components.filter((component) => component.promptDisposition !== "excluded");
  const estimated = possiblyPrompt.filter((component) => component.estimate.kind === "local_estimate");
  const eligibleCodePoints = sumSizes(possiblyPrompt).unicodeCodePoints;
  const coveredCodePoints = sumSizes(estimated).unicodeCodePoints;
  return {
    protocol,
    parsed,
    basis: "canonical_component_values_v1",
    source,
    components,
    totals: {
      componentValues: sumSizes(components),
      promptIncluded: sumSizes(included),
      transportExcluded: sumSizes(components.filter((component) => component.promptDisposition === "excluded")),
      promptUnknown: sumSizes(components.filter((component) => component.promptDisposition === "unknown")),
      localEstimate: {
        kind: "local_estimate",
        estimatorId: ESTIMATOR_ID,
        tokens: estimated.reduce(
          (sum, component) => sum + (component.estimate.kind === "local_estimate" ? component.estimate.tokens : 0),
          0
        ),
        coveredCodePoints,
        eligibleCodePoints,
        coverage: eligibleCodePoints === 0 ? null : coveredCodePoints / eligibleCodePoints
      }
    }
  };
}
