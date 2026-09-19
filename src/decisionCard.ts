import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  DECISION_CARD_COMMENT_MAX_CHARACTERS,
  DECISION_CARD_HTML_MAX_BYTES,
  DECISION_CARD_MAX_FIELDS,
  DECISION_CARD_MAX_OPTIONS,
  DECISION_FIELD_KINDS,
  DECISION_INTENTS
} from "./decisionCardContent.js";
import {
  DECISION_CARD_MAX_EXPIRY_MINUTES,
  DECISION_DELIVERY_STATES,
  type DecisionCardSnapshot,
  type DecisionCardStore,
  type DecisionSubmissionRecord
} from "./decisionCardStore.js";
import { PRODUCT_INFO } from "./productInfo.js";
import type { ScopeResolver, ToolCallMetadata } from "./scopeResolver.js";
import {
  currentUiResourceRevision,
  htmlForUiResource,
  uiRevisionMetadata,
  type UiResourceName
} from "./uiResources.js";
import {
  hostToolResultMetadata,
  normalizeHostToolResult,
  parseUiJsonTextStrict,
  uiJsonTextIsWellFormed
} from "./uiHostToolResult.js";
import { callUiToolWithFallback, withUiToolCallTimeout } from "./uiToolCallFallback.js";
import { serializeUiFunction } from "./uiFunctionSerialization.js";

const DECISION_RESOURCE_NAME = "decision" as UiResourceName;
export const DECISION_CARD_URI = "ui://codex-mcp-bridge/decision/v1.html";
export const DECISION_CARD_CONTRACT_GENERATION = 1;
export const DECISION_CARD_MIME_TYPE = "text/html;profile=mcp-app";
export const DECISION_CARD_STATIC_HTML_MAX_BYTES = 96 * 1_024;
export const DECISION_CARD_METADATA_KEY = "codex/decisionCard@1";

export const DECISION_CARD_MINIMAL_HTML_EXAMPLE =
  '<fieldset><legend>Rollout</legend><label><input type="radio" name="plan" value="staged" required>Staged</label><label><input type="radio" name="plan" value="direct">Direct</label></fieldset><label>Duration <input type="number" name="weeks" min="1" max="12" data-decision-unit="weeks" required></label>';

export const DECISION_CARD_AUTHORING_GUIDANCE = [
  "Always include operation: use create for a new card, or revise with the exact cardId and expectedVersion returned by the current card.",
  "Author free-form HTML, but collect decisions only with enabled native input, select, or textarea controls.",
  "Every collected control needs a stable name starting with a letter and a human-visible label; use a wrapping label, label[for], fieldset/legend for radio or multi-checkbox groups, or data-decision-label.",
  "Give every choice a non-empty value and a descriptive visible option label so the submitted value preserves what the user saw. required applies only when the user confirms.",
  "Use data-decision-unit for units and data-decision-output-for to mirror a range value when useful.",
  `HTML is limited to 96 KiB (${DECISION_CARD_HTML_MAX_BYTES} UTF-8 bytes), ${DECISION_CARD_MAX_FIELDS} derived fields, and ${DECISION_CARD_MAX_OPTIONS} options per field.`,
  "Static inline SVG and base64 raster data images are supported; scripts, event handlers, remote resources, navigation, and generated JavaScript are removed.",
  `Minimal example: ${DECISION_CARD_MINIMAL_HTML_EXAMPLE}`
].join(" ");

export const DECISION_CARD_RESOURCE_DESCRIPTOR = {
  title: `${PRODUCT_INFO.displayName} Decision`,
  description: "A trusted decision-card runtime for server-sanitized, free-form HTML and semantic user confirmation.",
  mimeType: DECISION_CARD_MIME_TYPE
} as const;

export const DECISION_CARD_CONTENT_METADATA = {
  ui: {
    prefersBorder: false,
    csp: { connectDomains: [] as string[], resourceDomains: [] as string[] },
    domain: "https://web-sandbox.oaiusercontent.com"
  },
  "openai/widgetDescription":
    "Displays one GPT-authored decision aid as sanitized free-form HTML, collects semantic native inputs, stores explicit user confirmation, and returns it to this conversation without executing the decision.",
  "openai/widgetPrefersBorder": false,
  "openai/widgetCSP": { connect_domains: [] as string[], resource_domains: [] as string[] },
  "openai/widgetDomain": "https://web-sandbox.oaiusercontent.com",
  "codex/uiContractGeneration": DECISION_CARD_CONTRACT_GENERATION
} as const;

const decisionOptionOutputSchema = z.strictObject({ value: z.string(), label: z.string() });
const decisionSelectionOutputSchema = z.strictObject({
  name: z.string(),
  label: z.string(),
  kind: z.enum(DECISION_FIELD_KINDS),
  values: z.array(decisionOptionOutputSchema),
  unit: z.string().nullable()
});
const decisionSubmissionOutputSchema = z.strictObject({
  submissionId: z.string().uuid(),
  receipt: z.string().regex(/^decision_[a-f0-9]{64}$/),
  sequence: z.number().int().positive(),
  supersedesSubmissionId: z.string().uuid().nullable(),
  intent: z.enum(DECISION_INTENTS),
  selections: z.array(decisionSelectionOutputSchema),
  comment: z.string().nullable(),
  summary: z.string(),
  deliveryState: z.enum(DECISION_DELIVERY_STATES),
  attemptCount: z.number().int().min(0),
  hostAcceptedAt: z.iso.datetime().nullable(),
  acceptanceUnknownAt: z.iso.datetime().nullable(),
  resultOfferedAt: z.iso.datetime().nullable(),
  confirmedAt: z.iso.datetime()
});

export const decisionCardOpenOutputSchema = z.strictObject({
  kind: z.literal("decision-card"),
  operation: z.enum(["create", "revise"]),
  cardId: z.string().uuid(),
  version: z.number().int().positive(),
  state: z.literal("open"),
  title: z.string(),
  fieldCount: z.number().int().min(0).max(DECISION_CARD_MAX_FIELDS),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
  summary: z.string()
});

export const decisionResultOutputSchema = z.strictObject({
  kind: z.literal("decision-result"),
  card: z.strictObject({
    cardId: z.string().uuid(),
    version: z.number().int().positive(),
    title: z.string(),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/)
  }),
  submission: decisionSubmissionOutputSchema,
  authority: z.strictObject({
    scope: z.literal("same-conversation"),
    executionApproved: z.literal(false),
    note: z.string()
  })
});

export const decisionUiOutputSchema = z.strictObject({
  kind: z.literal("decision-ui"),
  operation: z.enum(["read", "submit", "claim", "outcome"]),
  cardId: z.string().uuid(),
  version: z.number().int().positive(),
  deliveryState: z.enum(DECISION_DELIVERY_STATES).nullable(),
  send: z.boolean(),
  receipt: z.string().regex(/^decision_[a-f0-9]{64}$/).nullable(),
  submission: decisionSubmissionOutputSchema.nullable()
});

const compatibilityScopeInput = z.string().uuid().optional().describe(
  "Compatibility scope for a non-ChatGPT MCP host. ChatGPT conversation metadata always takes precedence."
);
const cardMutationBase = {
  requestId: z.string().uuid().describe("Unique UUID for this logical card mutation. Reuse only for an identical retry."),
  title: z.string().min(1).max(200).describe("Visible card title, in the user's language, up to 200 characters."),
  html: z.string().min(1).max(DECISION_CARD_HTML_MAX_BYTES)
    .refine((value) => Buffer.byteLength(value, "utf8") <= DECISION_CARD_HTML_MAX_BYTES, {
      message: `HTML must be at most ${DECISION_CARD_HTML_MAX_BYTES} UTF-8 bytes.`
    })
    .describe(
      "Free-form sanitized HTML body. Follow the tool's authoring contract and minimal example. " +
      "Use native input/select/textarea controls with stable names and visible labels; visible choice meanings, values, bounds, required state, and units become the submitted contract."
    ),
  expiresInMinutes: z.number().int().min(5).max(DECISION_CARD_MAX_EXPIRY_MINUTES).optional().describe(
    `Optional lifetime in minutes, from 5 to ${DECISION_CARD_MAX_EXPIRY_MINUTES}.`
  ),
  scopeId: compatibilityScopeInput
};
const decisionCardInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("create").describe("Required discriminator for opening a new decision card."),
    ...cardMutationBase
  }),
  z.strictObject({
    operation: z.literal("revise").describe("Required discriminator for replacing the current open card version."),
    ...cardMutationBase,
    cardId: z.string().uuid().describe("Exact cardId returned by the card being revised."),
    expectedVersion: z.number().int().positive().describe("Exact current version; stale revisions fail closed.")
  })
]).describe("Create or revise one decision card. The operation discriminator is always required.");

const decisionResultInputSchema = z.strictObject({
  receipt: z.string().regex(/^decision_[a-f0-9]{64}$/),
  scopeId: compatibilityScopeInput
});

const decisionProofInput = {
  cardId: z.string().uuid(),
  cardVersion: z.number().int().positive(),
  presentationRef: z.string().regex(/^[a-f0-9]{64}$/),
  widgetInstanceId: z.string().uuid(),
  scopeId: compatibilityScopeInput
};
const submittedFieldInput = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/),
  values: z.array(z.string().max(4_000)).max(DECISION_CARD_MAX_OPTIONS)
});
const decisionUiInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("read"), ...decisionProofInput }),
  z.strictObject({
    operation: z.literal("submit"),
    ...decisionProofInput,
    submissionId: z.string().uuid(),
    intent: z.enum(DECISION_INTENTS),
    fields: z.array(submittedFieldInput).max(DECISION_CARD_MAX_FIELDS),
    comment: z.string().max(DECISION_CARD_COMMENT_MAX_CHARACTERS).optional()
  }),
  z.strictObject({
    operation: z.literal("claim"),
    ...decisionProofInput,
    receipt: z.string().regex(/^decision_[a-f0-9]{64}$/),
    retryRejected: z.boolean().optional()
  }),
  z.strictObject({
    operation: z.literal("outcome"),
    ...decisionProofInput,
    receipt: z.string().regex(/^decision_[a-f0-9]{64}$/),
    outcome: z.enum(["accepted", "rejected", "uncertain", "release"]),
    error: z.string().max(500).optional()
  })
]);

export function registerDecisionCardResource(server: McpServer): void {
  const revision = currentUiResourceRevision(DECISION_RESOURCE_NAME);
  const revisionMetadata = uiRevisionMetadata(
    revision,
    DECISION_CARD_RESOURCE_DESCRIPTOR,
    DECISION_CARD_CONTENT_METADATA
  );
  server.registerResource(
    "codex-decision-card",
    revision.uri,
    revisionMetadata.descriptor,
    async () => ({
      contents: [{
        uri: revision.uri,
        mimeType: DECISION_CARD_MIME_TYPE,
        text: htmlForUiResource(DECISION_RESOURCE_NAME, revision.uri, DECISION_CARD_HTML),
        _meta: revisionMetadata.content
      }]
    })
  );
}

export function registerDecisionCardTools(
  server: McpServer,
  decisions: DecisionCardStore,
  scopeResolver: ScopeResolver
): void {
  server.registerTool("codex_decision", {
    title: "Create or Revise a Decision Card",
    description:
      "Create a free-form HTML decision aid for this GPT conversation, or revise an existing card. Use it when comparison, visual explanation, or editable conditions materially help the user decide; use normal conversation for simple questions. " +
      DECISION_CARD_AUTHORING_GUIDANCE +
      " This tool only opens the card; it never creates or runs a Codex task and confirmation is not execution approval.",
    inputSchema: decisionCardInputSchema,
    outputSchema: decisionCardOpenOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      ui: { resourceUri: DECISION_CARD_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": DECISION_CARD_URI,
      "openai/widgetAccessible": true,
      "codex/uiContractGeneration": DECISION_CARD_CONTRACT_GENERATION
    }
  }, async (args, extra) => {
    const scope = scopeResolver.require(
      extra.mcpReq._meta as ToolCallMetadata,
      args.scopeId,
      "Decision card creation"
    );
    const card = args.operation === "create"
      ? decisions.create(scope.scopeId, args)
      : decisions.revise(scope.scopeId, args);
    const snapshot = decisions.snapshot(scope.scopeId, {
      cardId: card.cardId,
      cardVersion: card.version,
      presentationRef: card.presentationRef
    });
    const summary = args.operation === "create"
      ? "The decision card is open. Its confirmation applies only to the decision shown and is not execution approval."
      : "The revised decision card is open. Older mounted versions cannot submit. Confirmation is not execution approval.";
    const structured = decisionCardOpenOutputSchema.parse({
      kind: "decision-card",
      operation: args.operation,
      cardId: card.cardId,
      version: card.version,
      state: "open",
      title: card.title,
      fieldCount: card.fields.length,
      contentDigest: card.contentDigest,
      expiresAt: new Date(card.expiresAt).toISOString(),
      summary
    });
    return {
      content: [{ type: "text" as const, text: summary }],
      structuredContent: structured,
      _meta: {
        [DECISION_CARD_METADATA_KEY]: decisionHydration(snapshot,
          scope.source === "explicit-compatibility" ? scope.scopeId : undefined)
      }
    };
  });

  server.registerTool("codex_decision_result", {
    title: "Read a Confirmed Decision",
    description:
      "Read one exact decision submitted from a decision card in this same conversation. Use only the receipt delivered by the card. Report the selected meanings, edits, conditions, and intent accurately before continuing. A confirmed decision is not permission for unrelated execution, external side effects, or bypassing existing approvals.",
    inputSchema: decisionResultInputSchema,
    outputSchema: decisionResultOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (args, extra) => {
    const scope = scopeResolver.require(
      extra.mcpReq._meta as ToolCallMetadata,
      args.scopeId,
      "Decision result read"
    );
    const result = decisions.readResult(scope.scopeId, args.receipt);
    const structured = decisionResultOutputSchema.parse({
      kind: "decision-result",
      card: {
        cardId: result.card.cardId,
        version: result.card.version,
        title: result.card.title,
        contentDigest: result.card.contentDigest
      },
      submission: modelSubmission(result.submission),
      authority: {
        scope: "same-conversation",
        executionApproved: false,
        note: "Apply this decision only within the card's stated scope. Recheck any separate execution or permission requirements."
      }
    });
    return {
      content: [{
        type: "text" as const,
        text: `${result.card.title}\n${result.submission.summary}\n\nThis is a stored user decision, not execution approval.`
      }],
      structuredContent: structured
    };
  });

  server.registerTool("codex_ui_decision", {
    title: "Operate a Decision Card",
    description:
      "App-only decision-card read, durable submission, bounded delivery claim, and host outcome journal. It cannot execute the user's decision.",
    inputSchema: decisionUiInputSchema,
    outputSchema: decisionUiOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      ui: { visibility: ["app"] },
      "openai/visibility": "private",
      "openai/widgetAccessible": true
    }
  }, async (args, extra) => {
    const scope = scopeResolver.require(
      extra.mcpReq._meta as ToolCallMetadata,
      args.scopeId,
      "Decision card operation"
    );
    const proof = {
      cardId: args.cardId,
      cardVersion: args.cardVersion,
      presentationRef: args.presentationRef
    };
    let snapshot: DecisionCardSnapshot;
    let send = false;
    if (args.operation === "read") {
      snapshot = decisions.snapshot(scope.scopeId, proof);
    } else if (args.operation === "submit") {
      const submission = decisions.submit(scope.scopeId, proof, {
        submissionId: args.submissionId,
        intent: args.intent,
        fields: args.fields,
        comment: args.comment
      });
      snapshot = { card: decisions.get(scope.scopeId, args.cardId), latestSubmission: submission };
    } else if (args.operation === "claim") {
      const claim = decisions.claimDelivery({
        scopeId: scope.scopeId,
        proof,
        receipt: args.receipt,
        leaseOwner: args.widgetInstanceId,
        retryRejected: args.retryRejected
      });
      send = claim.send;
      snapshot = { card: decisions.get(scope.scopeId, args.cardId), latestSubmission: claim.submission };
    } else {
      const submission = decisions.recordDeliveryOutcome({
        scopeId: scope.scopeId,
        proof,
        receipt: args.receipt,
        leaseOwner: args.widgetInstanceId,
        outcome: args.outcome,
        error: args.error
      });
      snapshot = { card: decisions.get(scope.scopeId, args.cardId), latestSubmission: submission };
    }
    const submission = snapshot.latestSubmission;
    const structured = decisionUiOutputSchema.parse({
      kind: "decision-ui",
      operation: args.operation,
      cardId: snapshot.card.cardId,
      version: snapshot.card.version,
      deliveryState: submission?.deliveryState || null,
      send,
      receipt: submission?.receipt || null,
      submission: submission ? modelSubmission(submission) : null
    });
    return {
      content: [{ type: "text" as const, text: "Decision card state updated." }],
      structuredContent: structured,
      _meta: { [DECISION_CARD_METADATA_KEY]: decisionHydration(snapshot,
        scope.source === "explicit-compatibility" ? scope.scopeId : undefined) }
    };
  });
}

function modelSubmission(submission: DecisionSubmissionRecord) {
  return {
    submissionId: submission.submissionId,
    receipt: submission.receipt,
    sequence: submission.sequence,
    supersedesSubmissionId: submission.supersedesSubmissionId || null,
    intent: submission.intent,
    selections: submission.selections.map((selection) => ({
      ...selection,
      unit: selection.unit || null
    })),
    comment: submission.comment || null,
    summary: submission.summary,
    deliveryState: submission.deliveryState,
    attemptCount: submission.attemptCount,
    hostAcceptedAt: isoOrNull(submission.hostAcceptedAt),
    acceptanceUnknownAt: isoOrNull(submission.acceptanceUnknownAt),
    resultOfferedAt: isoOrNull(submission.resultOfferedAt),
    confirmedAt: new Date(submission.createdAt).toISOString()
  };
}

function decisionHydration(snapshot: DecisionCardSnapshot, compatibilityScopeId?: string) {
  return {
    kind: "codex/decisionCard",
    version: 1,
    card: {
      cardId: snapshot.card.cardId,
      cardVersion: snapshot.card.version,
      title: snapshot.card.title,
      html: snapshot.card.html,
      contentDigest: snapshot.card.contentDigest,
      fields: snapshot.card.fields,
      policy: snapshot.card.policy,
      presentationRef: snapshot.card.presentationRef,
      expiresAt: new Date(snapshot.card.expiresAt).toISOString()
    },
    latestSubmission: snapshot.latestSubmission ? modelSubmission(snapshot.latestSubmission) : null,
    compatibilityScopeId: compatibilityScopeId || null
  };
}

function isoOrNull(value: number | undefined): string | null {
  return value === undefined ? null : new Date(value).toISOString();
}

const DECISION_CARD_TRANSLATIONS = {
  en: {
    loading: "Loading decision…", note: "Your confirmation is stored before delivery. It applies only to this decision and does not approve execution.",
    review: "Decision to send", notProvided: "Not provided", yes: "Yes", no: "No", comment: "Conditions or comments", commentPlaceholder: "Add constraints, exceptions, or what you still need explained.",
    confirm: "Confirm decision", explain: "Need more explanation", defer: "Decide later", retry: "Retry delivery",
    stored: "Decision stored. Preparing same-conversation delivery…", sending: "Decision stored. Sending it to this conversation…",
    accepted: "The host accepted the follow-up. Waiting for GPT to use the exact stored decision.",
    offered: "The exact stored decision was provided to GPT.", rejected: "The decision is stored, but the host rejected delivery. You can retry explicitly.",
    uncertain: "The decision is stored. Delivery acceptance is unknown, so it will not be resent automatically.",
    stale: "This card is no longer current. Ask GPT to reopen the latest version.", error: "The decision could not be submitted.",
    required: "Complete the required fields first.", revised: "A later confirmation will be recorded as a revision of the previous decision."
  },
  ko: {
    loading: "의사결정 불러오는 중…", note: "확정 내용은 전달 전에 먼저 저장됩니다. 이 결정 범위에만 적용되며 실행 승인이 아닙니다.",
    review: "전달할 결정", notProvided: "입력하지 않음", yes: "예", no: "아니요", comment: "조건 또는 의견", commentPlaceholder: "제약, 예외, 더 설명이 필요한 내용을 적어 주세요.",
    confirm: "결정 확정", explain: "추가 설명 필요", defer: "나중에 결정", retry: "전달 다시 시도",
    stored: "결정을 저장했습니다. 같은 대화로 전달할 준비 중입니다…", sending: "결정을 저장했습니다. 같은 대화로 전달 중입니다…",
    accepted: "호스트가 후속 메시지를 수락했습니다. GPT가 저장된 정확한 결정을 확인하기를 기다립니다.",
    offered: "저장된 정확한 결정이 GPT에 제공되었습니다.", rejected: "결정은 저장됐지만 호스트가 전달을 거절했습니다. 명시적으로 다시 시도할 수 있습니다.",
    uncertain: "결정은 저장됐습니다. 전달 수락 여부를 알 수 없어 자동 재전송하지 않습니다.",
    stale: "이 카드는 최신 버전이 아닙니다. GPT에게 최신 카드를 다시 열어 달라고 요청하세요.", error: "결정을 제출하지 못했습니다.",
    required: "필수 항목을 먼저 입력해 주세요.", revised: "다시 확정하면 이전 결정을 대체하는 수정 제출로 기록됩니다."
  },
  ja: {
    loading: "意思決定を読み込み中…", note: "確定内容は送信前に保存され、この決定範囲にのみ適用されます。実行承認ではありません。",
    review: "送信する決定", notProvided: "未入力", yes: "はい", no: "いいえ", comment: "条件またはコメント", commentPlaceholder: "制約、例外、追加説明が必要な点を入力してください。",
    confirm: "決定を確定", explain: "追加説明が必要", defer: "後で決める", retry: "送信を再試行",
    stored: "決定を保存しました。同じ会話への送信を準備中です…", sending: "決定を保存しました。同じ会話へ送信中です…",
    accepted: "ホストがフォローアップを受理しました。GPTによる正確な決定の確認を待っています。", offered: "保存された正確な決定がGPTに提供されました。",
    rejected: "決定は保存されましたが、ホストが送信を拒否しました。明示的に再試行できます。", uncertain: "決定は保存されました。受理状態が不明なため自動再送しません。",
    stale: "このカードは最新ではありません。GPTに最新版を開くよう依頼してください。", error: "決定を送信できませんでした。", required: "必須項目を入力してください。", revised: "再確定すると前の決定を置き換える修正として記録されます。"
  },
  "zh-Hans": {
    loading: "正在加载决策…", note: "确认内容会先保存再传递，仅适用于此决策范围，并不代表执行授权。", review: "将传递的决策", notProvided: "未填写", yes: "是", no: "否", comment: "条件或意见", commentPlaceholder: "添加限制、例外或仍需解释的内容。",
    confirm: "确认决策", explain: "需要更多说明", defer: "稍后决定", retry: "重试传递", stored: "决策已保存，正在准备传回同一对话…", sending: "决策已保存，正在传回同一对话…",
    accepted: "主机已接受后续消息，正在等待GPT使用准确的已存决策。", offered: "准确的已存决策已提供给GPT。", rejected: "决策已保存，但主机拒绝传递。你可以明确重试。",
    uncertain: "决策已保存。传递是否被接受不明确，因此不会自动重发。", stale: "此卡片已不是最新版，请让GPT重新打开最新版。", error: "无法提交决策。", required: "请先完成必填项。", revised: "再次确认会作为替代上次决策的修订提交。"
  },
  "zh-Hant": {
    loading: "正在載入決策…", note: "確認內容會先儲存再傳遞，僅適用於此決策範圍，並不代表執行授權。", review: "將傳遞的決策", notProvided: "未填寫", yes: "是", no: "否", comment: "條件或意見", commentPlaceholder: "加入限制、例外或仍需說明的內容。",
    confirm: "確認決策", explain: "需要更多說明", defer: "稍後決定", retry: "重試傳遞", stored: "決策已儲存，正在準備傳回同一對話…", sending: "決策已儲存，正在傳回同一對話…",
    accepted: "主機已接受後續訊息，正在等待GPT使用準確的已存決策。", offered: "準確的已存決策已提供給GPT。", rejected: "決策已儲存，但主機拒絕傳遞。你可以明確重試。",
    uncertain: "決策已儲存。傳遞是否被接受不明，因此不會自動重送。", stale: "此卡片已不是最新版，請讓GPT重新開啟最新版。", error: "無法提交決策。", required: "請先完成必填項目。", revised: "再次確認會記錄為取代上次決策的修訂提交。"
  },
  es: {
    loading: "Cargando decisión…", note: "La confirmación se guarda antes de enviarse, solo se aplica a esta decisión y no autoriza la ejecución.", review: "Decisión que se enviará", notProvided: "Sin indicar", yes: "Sí", no: "No", comment: "Condiciones o comentarios", commentPlaceholder: "Añade restricciones, excepciones o puntos que necesiten explicación.",
    confirm: "Confirmar decisión", explain: "Necesito más explicación", defer: "Decidir después", retry: "Reintentar entrega", stored: "Decisión guardada. Preparando la entrega a esta conversación…", sending: "Decisión guardada. Enviándola a esta conversación…",
    accepted: "El host aceptó el seguimiento. Esperando a que GPT use la decisión exacta guardada.", offered: "La decisión exacta guardada se proporcionó a GPT.", rejected: "La decisión está guardada, pero el host rechazó la entrega. Puedes reintentar explícitamente.",
    uncertain: "La decisión está guardada. La aceptación es incierta, por lo que no se reenviará automáticamente.", stale: "Esta tarjeta ya no es actual. Pide a GPT que abra la última versión.", error: "No se pudo enviar la decisión.", required: "Completa primero los campos obligatorios.", revised: "Otra confirmación se registrará como revisión de la decisión anterior."
  },
  fr: {
    loading: "Chargement de la décision…", note: "La confirmation est enregistrée avant l’envoi, ne vaut que pour cette décision et n’autorise pas l’exécution.", review: "Décision à envoyer", notProvided: "Non renseigné", yes: "Oui", no: "Non", comment: "Conditions ou commentaires", commentPlaceholder: "Ajoutez les contraintes, exceptions ou points à expliquer.",
    confirm: "Confirmer la décision", explain: "Besoin d’explications", defer: "Décider plus tard", retry: "Réessayer l’envoi", stored: "Décision enregistrée. Préparation de l’envoi dans cette conversation…", sending: "Décision enregistrée. Envoi dans cette conversation…",
    accepted: "L’hôte a accepté le suivi. En attente de l’utilisation par GPT de la décision exacte.", offered: "La décision exacte enregistrée a été fournie à GPT.", rejected: "La décision est enregistrée, mais l’hôte a refusé l’envoi. Vous pouvez réessayer explicitement.",
    uncertain: "La décision est enregistrée. L’acceptation est incertaine, donc aucun renvoi automatique.", stale: "Cette carte n’est plus à jour. Demandez à GPT d’ouvrir la dernière version.", error: "Impossible d’envoyer la décision.", required: "Complétez d’abord les champs obligatoires.", revised: "Une nouvelle confirmation sera enregistrée comme révision de la précédente."
  },
  de: {
    loading: "Entscheidung wird geladen…", note: "Die Bestätigung wird vor der Übermittlung gespeichert, gilt nur für diese Entscheidung und ist keine Ausführungsfreigabe.", review: "Zu sendende Entscheidung", notProvided: "Nicht angegeben", yes: "Ja", no: "Nein", comment: "Bedingungen oder Kommentare", commentPlaceholder: "Einschränkungen, Ausnahmen oder offenen Erklärungsbedarf ergänzen.",
    confirm: "Entscheidung bestätigen", explain: "Mehr Erklärung nötig", defer: "Später entscheiden", retry: "Übermittlung wiederholen", stored: "Entscheidung gespeichert. Übermittlung in diese Unterhaltung wird vorbereitet…", sending: "Entscheidung gespeichert. Übermittlung in diese Unterhaltung…",
    accepted: "Der Host hat die Folgemeldung angenommen. GPT muss die genaue gespeicherte Entscheidung noch verwenden.", offered: "Die genaue gespeicherte Entscheidung wurde GPT bereitgestellt.", rejected: "Die Entscheidung ist gespeichert, aber der Host hat die Übermittlung abgelehnt. Sie können ausdrücklich wiederholen.",
    uncertain: "Die Entscheidung ist gespeichert. Die Annahme ist unklar, daher keine automatische Wiederholung.", stale: "Diese Karte ist nicht mehr aktuell. Bitten Sie GPT, die neueste Version zu öffnen.", error: "Die Entscheidung konnte nicht übermittelt werden.", required: "Bitte zuerst alle Pflichtfelder ausfüllen.", revised: "Eine erneute Bestätigung wird als Revision der vorherigen Entscheidung gespeichert."
  },
  pt: {
    loading: "Carregando decisão…", note: "A confirmação é salva antes do envio, vale apenas para esta decisão e não autoriza execução.", review: "Decisão que será enviada", notProvided: "Não informado", yes: "Sim", no: "Não", comment: "Condições ou comentários", commentPlaceholder: "Adicione restrições, exceções ou pontos que ainda precisam de explicação.",
    confirm: "Confirmar decisão", explain: "Preciso de mais explicação", defer: "Decidir depois", retry: "Tentar entrega novamente", stored: "Decisão salva. Preparando a entrega nesta conversa…", sending: "Decisão salva. Enviando para esta conversa…",
    accepted: "O host aceitou o acompanhamento. Aguardando o GPT usar a decisão exata salva.", offered: "A decisão exata salva foi fornecida ao GPT.", rejected: "A decisão está salva, mas o host rejeitou a entrega. Você pode tentar novamente explicitamente.",
    uncertain: "A decisão está salva. A aceitação é incerta, portanto não haverá reenvio automático.", stale: "Este cartão não é mais atual. Peça ao GPT para abrir a versão mais recente.", error: "Não foi possível enviar a decisão.", required: "Preencha primeiro os campos obrigatórios.", revised: "Uma nova confirmação será registrada como revisão da decisão anterior."
  }
} as const;

export const DECISION_CARD_HTML = String.raw`<!doctype html>
<html lang="en" dir="auto">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Decision</title>
  <style>
    :root{color-scheme:light dark;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--muted:color-mix(in srgb,CanvasText 62%,transparent);--border:color-mix(in srgb,CanvasText 15%,transparent);--faint:color-mix(in srgb,CanvasText 7%,transparent);--active:#16875a;--warn:#b87503;--danger:#c34132}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:transparent;color:CanvasText}.card{padding:14px}.head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}h1{margin:0;font-size:17px;line-height:1.3}.version{flex:none;color:var(--muted);font-size:10px}.generated{margin-top:12px;padding:13px;border:1px solid var(--border);border-radius:12px;background:var(--faint);overflow:auto;overflow-wrap:anywhere}.generated :where(input,select,textarea){max-width:100%;font:inherit;color:CanvasText;background:Canvas;border:1px solid var(--border);border-radius:7px;padding:7px}.generated :where(input[type=radio],input[type=checkbox]){padding:0}.generated :where(select,textarea){width:100%}.generated table{width:100%;border-collapse:collapse}.generated :where(th,td){padding:6px;border:1px solid var(--border);text-align:left}.generated svg{max-width:100%;height:auto}.generated img{max-width:100%}.generated label{line-height:1.5}.generated fieldset{min-width:0;border:1px solid var(--border);border-radius:9px}.generated fieldset>label{display:block;margin:5px 0}.generated :focus-visible,.controls :focus-visible{outline:2px solid color-mix(in srgb,var(--active) 70%,transparent);outline-offset:2px}.common{margin-top:12px;padding-top:11px;border-top:1px solid var(--border)}.review{margin:0 0 11px;padding:10px;border:1px solid var(--border);border-radius:9px}.review h2{margin:0 0 7px;font-size:12px}.review dl{display:grid;grid-template-columns:minmax(90px,.42fr) minmax(0,1fr);gap:5px 9px;margin:0;font-size:12px}.review dt{font-weight:650}.review dd{margin:0;overflow-wrap:anywhere}.common label{display:block;font-size:12px;font-weight:650}.common textarea{width:100%;min-height:72px;margin-top:6px;resize:vertical;font:inherit;color:CanvasText;background:Canvas;border:1px solid var(--border);border-radius:8px;padding:8px}.controls{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}.controls button{border:1px solid var(--border);border-radius:8px;background:Canvas;color:CanvasText;padding:7px 10px;font-size:12px;font-weight:680;cursor:pointer}.controls button.primary{border-color:color-mix(in srgb,var(--active) 65%,var(--border));background:color-mix(in srgb,var(--active) 13%,Canvas)}.controls button:hover{background:var(--faint)}.controls button:disabled{opacity:.55;cursor:default}.notice,.status{font-size:11px;line-height:1.45}.notice{margin:10px 0 0;color:var(--muted)}.status{margin:10px 0 0;padding:8px 9px;border-radius:8px;background:var(--faint);color:var(--muted)}.status.error{color:var(--danger)}.status.warn{color:var(--warn)}.status.ok{color:var(--active)}@media(max-width:540px){.card{padding:12px}.review dl{grid-template-columns:1fr}.review dd{margin-bottom:4px}.controls{display:grid}.controls button{width:100%}}
  </style>
</head>
<body>
  <main class="card">
    <header class="head"><h1 id="title"></h1><span class="version" id="version"></span></header>
    <p class="status" id="loading"></p>
    <section class="generated" id="generated" hidden></section>
    <section class="common" id="common" hidden>
      <section class="review" id="review-section"><h2 id="review-label"></h2><dl id="review"></dl></section>
      <label for="comment" id="comment-label"></label>
      <textarea id="comment" maxlength="${DECISION_CARD_COMMENT_MAX_CHARACTERS}"></textarea>
      <div class="controls">
        <button class="primary" id="confirm" type="button"></button>
        <button id="explain" type="button"></button>
        <button id="defer" type="button"></button>
        <button id="retry" type="button" hidden></button>
      </div>
      <p class="notice" id="notice"></p>
      <p class="status" id="status" role="status" aria-live="polite" hidden></p>
    </section>
  </main>
  <script>
    const BUNDLES=${JSON.stringify(DECISION_CARD_TRANSLATIONS).replaceAll("<", "\\u003c")};
    ${serializeUiFunction(uiJsonTextIsWellFormed)}
    ${serializeUiFunction(parseUiJsonTextStrict)}
    ${serializeUiFunction(normalizeHostToolResult)}
    ${serializeUiFunction(hostToolResultMetadata)}
    ${serializeUiFunction(withUiToolCallTimeout)}
    ${serializeUiFunction(callUiToolWithFallback)}
    const META_KEY=${JSON.stringify(DECISION_CARD_METADATA_KEY)},CONTRACT=${DECISION_CARD_CONTRACT_GENERATION},TOOL_TIMEOUT=15000,INIT_TIMEOUT=5000,MESSAGE_TIMEOUT=12000;
    const localeTag=String(window.openai&&window.openai.locale||navigator.language||"en").replaceAll("_","-");
    function localeKey(value){const v=String(value).toLowerCase();if(v==="ko"||v.startsWith("ko-"))return"ko";if(v==="ja"||v.startsWith("ja-"))return"ja";if(v.startsWith("zh-hant")||/^zh-(tw|hk|mo)/.test(v))return"zh-Hant";if(v==="zh"||v.startsWith("zh-"))return"zh-Hans";for(const key of["es","fr","de","pt"])if(v===key||v.startsWith(key+"-"))return key;return"en"}
    const t=BUNDLES[localeKey(localeTag)]||BUNDLES.en;document.documentElement.lang=localeTag;
    const el={title:document.getElementById("title"),version:document.getElementById("version"),loading:document.getElementById("loading"),generated:document.getElementById("generated"),common:document.getElementById("common"),reviewSection:document.getElementById("review-section"),review:document.getElementById("review"),reviewLabel:document.getElementById("review-label"),comment:document.getElementById("comment"),commentLabel:document.getElementById("comment-label"),confirm:document.getElementById("confirm"),explain:document.getElementById("explain"),defer:document.getElementById("defer"),retry:document.getElementById("retry"),notice:document.getElementById("notice"),status:document.getElementById("status")};
    el.loading.textContent=t.loading;el.reviewLabel.textContent=t.review;el.commentLabel.textContent=t.comment;el.comment.placeholder=t.commentPlaceholder;el.confirm.textContent=t.confirm;el.explain.textContent=t.explain;el.defer.textContent=t.defer;el.retry.textContent=t.retry;el.notice.textContent=t.note;
    function uuid(){const c=globalThis.crypto;if(c&&typeof c.randomUUID==="function")return c.randomUUID();const b=new Uint8Array(16);c.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;const h=Array.from(b,x=>x.toString(16).padStart(2,"0")).join("");return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}
    const widgetInstanceId=uuid(),pending=new Map();let requestId=1,mounted=true,initialized=false,initializing=null,hydration=null,latestSubmission=null,busy=false,pollTimer=0,sizeFrame=0,lastWidth=0,lastHeight=0;
    function errorText(value){if(typeof value==="string")return value;if(value&&typeof value.message==="string")return value.message;if(value&&value.error)return errorText(value.error);try{return JSON.stringify(value)}catch{return t.error}}
    function rpc(method,params,timeout=70000,code=""){return new Promise((resolve,reject)=>{const id=requestId++,timer=setTimeout(()=>{pending.delete(id);const e=new Error(t.error);e.code=code;reject(e)},timeout);pending.set(id,{resolve:(v)=>{clearTimeout(timer);resolve(v)},reject:(e)=>{clearTimeout(timer);reject(e)}});window.parent.postMessage({jsonrpc:"2.0",id,method,params},"*")})}
    function intrinsicHeight(){const html=document.documentElement,original=html.style.height;html.style.height="max-content";const height=Math.ceil(html.getBoundingClientRect().height);html.style.height=original;return height}
    function queueSizeChanged(force=false){cancelAnimationFrame(sizeFrame);sizeFrame=requestAnimationFrame(()=>{if(!mounted)return;const width=Math.ceil(window.innerWidth),height=intrinsicHeight();if(!force&&width===lastWidth&&height===lastHeight)return;lastWidth=width;lastHeight=height;if(initialized)window.parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{width,height}},"*");if(window.openai&&typeof window.openai.notifyIntrinsicHeight==="function")window.openai.notifyIntrinsicHeight(height)})}
    async function initialize(){if(initialized)return true;if(initializing)return initializing;initializing=(async()=>{try{const result=await rpc("ui/initialize",{appInfo:{name:"codex-mcp-bridge-decision",version:String(CONTRACT)},appCapabilities:{availableDisplayModes:["inline"]},protocolVersion:"2026-01-26"},INIT_TIMEOUT);if(!result||typeof result.protocolVersion!=="string")return false;initialized=true;window.parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/initialized",params:{}},"*");queueSizeChanged(true);return true}catch{return false}finally{initializing=null}})();return initializing}
    async function standardCall(name,args){if(!await initialize())throw new Error(t.error);const response=await rpc("tools/call",{name,arguments:args},TOOL_TIMEOUT,"MCP_TOOL_CALL_DISPATCH_TIMEOUT");return response&&response.result||response}
    async function callTool(name,args,readOnly=false){const compatibility=window.openai&&typeof window.openai.callTool==="function"?()=>window.openai.callTool(name,args):undefined;if(compatibility)return callUiToolWithFallback(compatibility,()=>standardCall(name,args),{standardTimeoutMs:TOOL_TIMEOUT,compatibilityTimeoutMs:INIT_TIMEOUT+TOOL_TIMEOUT+1000,timeoutMessage:t.error,shouldFallback:()=>readOnly});return callUiToolWithFallback(()=>standardCall(name,args),undefined,{standardTimeoutMs:INIT_TIMEOUT+TOOL_TIMEOUT+1000,compatibilityTimeoutMs:TOOL_TIMEOUT,timeoutMessage:t.error})}
    function unwrap(value){const result=normalizeHostToolResult(value),candidate=result&&result.structuredContent||value&&value.structuredContent||value;if(result&&result.isError)throw new Error(errorText(result));if(!candidate||candidate.kind!=="decision-ui")throw new Error(t.error);return candidate}
    function identity(operation,extra={}){const c=hydration.card;return{operation,cardId:c.cardId,cardVersion:c.cardVersion,presentationRef:c.presentationRef,widgetInstanceId,...(hydration.compatibilityScopeId?{scopeId:hydration.compatibilityScopeId}:{}),...extra}}
    function setBusy(value){busy=value;for(const button of[el.confirm,el.explain,el.defer,el.retry])button.disabled=value}
    function show(message,tone=""){el.status.hidden=false;el.status.className="status"+(tone?" "+tone:"");el.status.textContent=message;queueSizeChanged()}
    function applySubmission(submission){latestSubmission=submission||latestSubmission;el.retry.hidden=!(submission&&submission.deliveryState==="host-rejected"&&submission.attemptCount<3);if(!submission)return;if(submission.comment&&!el.comment.value)el.comment.value=submission.comment;if(submission.resultOfferedAt)show(t.offered,"ok");else if(submission.deliveryState==="host-accepted")show(t.accepted,"ok");else if(submission.deliveryState==="host-rejected")show(t.rejected,"warn");else if(submission.deliveryState==="acceptance-unknown")show(t.uncertain,"warn");else if(submission.deliveryState==="stored")show(t.stored);else if(submission.deliveryState==="leased")show(t.sending);el.notice.textContent=t.note+" "+t.revised}
    function selectedValues(definition,controls){const selected=[];if(definition.kind==="boolean")return controls.some(control=>control.checked)?["true"]:[];if(definition.kind==="choice"||definition.kind==="multi-choice"){for(const control of controls){if(control.tagName==="SELECT")selected.push(...[...control.selectedOptions].map(option=>option.value));else if(control.checked)selected.push(control.value)}return selected}const value=controls[0]&&controls[0].value;return value!==undefined&&value!==""?[value]:[]}
    function restoreSubmission(submission){if(!submission)return;for(const selection of submission.selections||[]){const definition=hydration.card.fields.find(field=>field.name===selection.name),controls=[...el.generated.querySelectorAll('[name="'+selection.name+'"]')],selected=new Set((selection.values||[]).map(value=>value.value));if(!definition)continue;if(definition.kind==="boolean"){for(const control of controls)control.checked=selected.has("true")}else if(definition.kind==="choice"||definition.kind==="multi-choice"){for(const control of controls){if(control.tagName==="SELECT")for(const option of control.options)option.selected=selected.has(option.value);else control.checked=selected.has(control.value)}}else if(controls[0])controls[0].value=selection.values&&selection.values[0]?selection.values[0].value:""}}
    function bindOutputs(){for(const output of el.generated.querySelectorAll("[data-decision-output-for]")){const name=output.dataset.decisionOutputFor,field=hydration.card.fields.find(x=>x.name===name),controls=[...el.generated.querySelectorAll('[name="'+name+'"]')];const update=()=>{const control=controls[0],value=control&&control.value||"";output.textContent=value+(field&&field.unit&&value?" "+field.unit:"")};for(const control of controls)control.addEventListener("input",update);update()}}
    function updatePreview(){el.review.textContent="";el.reviewSection.hidden=hydration.card.fields.length===0;for(const definition of hydration.card.fields){const controls=[...el.generated.querySelectorAll('[name="'+definition.name+'"]')],selected=selectedValues(definition,controls),dt=document.createElement("dt"),dd=document.createElement("dd");let labels;if(definition.kind==="boolean")labels=[selected.length?t.yes:t.no];else if(definition.kind==="choice"||definition.kind==="multi-choice")labels=selected.map(value=>{const option=(definition.options||[]).find(candidate=>candidate.value===value);return option?option.label:value});else labels=selected;dt.textContent=definition.label;dd.textContent=(labels.length?labels.join(", "):t.notProvided)+(definition.unit&&labels.length?" "+definition.unit:"");el.review.append(dt,dd)}queueSizeChanged()}
    function bindPreview(){for(const control of el.generated.querySelectorAll("input,select,textarea")){control.addEventListener("input",updatePreview);control.addEventListener("change",updatePreview)}el.comment.addEventListener("input",updatePreview);updatePreview()}
    function accept(value){if(!mounted)return false;const metadata=hostToolResultMetadata(value),candidate=metadata&&metadata[META_KEY];if(!candidate||candidate.kind!=="codex/decisionCard"||candidate.version!==1||!candidate.card||typeof candidate.card.html!=="string")return false;if(hydration){if(hydration.card.cardId!==candidate.card.cardId||hydration.card.cardVersion!==candidate.card.cardVersion)return false;hydration=candidate;applySubmission(candidate.latestSubmission);updatePreview();return true}hydration=candidate;el.title.textContent=candidate.card.title;document.title=candidate.card.title;el.version.textContent="v"+candidate.card.cardVersion;el.generated.innerHTML=candidate.card.html;el.generated.hidden=false;el.common.hidden=false;el.loading.hidden=true;el.generated.addEventListener("submit",event=>event.preventDefault());restoreSubmission(candidate.latestSubmission);applySubmission(candidate.latestSubmission);bindOutputs();bindPreview();queueSizeChanged(true);if(candidate.latestSubmission&&candidate.latestSubmission.deliveryState==="stored")void deliver(candidate.latestSubmission.receipt,false);return true}
    function values(intent){const fields=[];let valid=true;for(const definition of hydration.card.fields){const controls=[...el.generated.querySelectorAll('[name="'+definition.name+'"]')];if(intent==="confirm")for(const control of controls)if(typeof control.checkValidity==="function"&&!control.checkValidity())valid=false;fields.push({name:definition.name,values:selectedValues(definition,controls)})}if(!valid){const invalid=el.generated.querySelector(":invalid");if(invalid&&typeof invalid.reportValidity==="function")invalid.reportValidity();throw new Error(t.required)}return fields}
    async function submit(intent){if(!mounted||!hydration||busy)return;setBusy(true);try{const response=unwrap(await callTool("codex_ui_decision",identity("submit",{submissionId:uuid(),intent,fields:values(intent),...(el.comment.value?{comment:el.comment.value}:{})})));applySubmission(response.submission);show(t.stored);if(response.receipt)await deliver(response.receipt,response.deliveryState==="host-rejected")}catch(error){if(mounted){const message=errorText(error);show(/STALE|VERSION|PRESENTATION/.test(message)?t.stale:message||t.error,"error")}}finally{setBusy(false)}}
    async function outcome(receipt,state,error){try{return unwrap(await standardCall("codex_ui_decision",identity("outcome",{receipt,outcome:state,...(error?{error}: {})})))}catch{return null}}
    async function deliver(receipt,retryRejected){if(!mounted||!hydration)return;try{const claim=unwrap(await callTool("codex_ui_decision",identity("claim",{receipt,retryRejected}),false));applySubmission(claim.submission);if(!claim.send)return;if(!mounted){await outcome(receipt,"release");return}show(t.sending);const prompt="The user submitted a decision card response. Use only Codex MCP Bridge for ChatGPT. Call codex_decision_result exactly once with receipt \""+receipt+"\". Accurately acknowledge the stored intent, selected meanings, edits, conditions, and comments, then continue this same conversation. The decision is not execution approval and does not bypass any permission check.";try{const response=await rpc("ui/message",{role:"user",content:[{type:"text",text:prompt}]},MESSAGE_TIMEOUT,"DECISION_MESSAGE_TIMEOUT");if(response&&(response.isError===true||response.error)){const e=new Error(errorText(response));e.code="DECISION_HOST_REJECTED";throw e}const recorded=await outcome(receipt,"accepted");applySubmission(recorded&&recorded.submission||{...claim.submission,deliveryState:"host-accepted"});if(mounted)schedulePoll()}catch(error){const code=error&&error.code||"",uncertain=!['DECISION_HOST_REJECTED','MCP_RPC_RESPONSE_ERROR'].includes(code);const recorded=await outcome(receipt,uncertain?"uncertain":"rejected",uncertain?undefined:errorText(error));applySubmission(recorded&&recorded.submission||{...claim.submission,deliveryState:uncertain?"acceptance-unknown":"host-rejected"})}}catch(error){if(mounted){const message=errorText(error);show(/STALE|VERSION|PRESENTATION/.test(message)?t.stale:message||t.error,"error")}}}
    async function refresh(){if(!mounted||!hydration)return;try{const value=unwrap(await callTool("codex_ui_decision",identity("read"),true));applySubmission(value.submission)}catch(error){if(/STALE|VERSION|PRESENTATION/.test(errorText(error)))show(t.stale,"warn")}}
    function schedulePoll(){let remaining=12;clearInterval(pollTimer);pollTimer=setInterval(()=>{if(--remaining<0){clearInterval(pollTimer);return}void refresh()},5000)}
    el.confirm.addEventListener("click",()=>void submit("confirm"));el.explain.addEventListener("click",()=>void submit("request-explanation"));el.defer.addEventListener("click",()=>void submit("defer"));el.retry.addEventListener("click",()=>{const receipt=latestSubmission&&latestSubmission.receipt;if(receipt){setBusy(true);void deliver(receipt,true).finally(()=>setBusy(false))}});
    accept(window.openai&&window.openai.toolResponseMetadata);accept(window.openai&&window.openai.toolOutput);
    window.addEventListener("message",event=>{if(event.source!==window.parent)return;const message=event.data;if(!message||message.jsonrpc!=="2.0")return;if(message.method==="ping"&&message.id!==undefined){window.parent.postMessage({jsonrpc:"2.0",id:message.id,result:{}},"*");return}if(message.method==="ui/resource-teardown"){mounted=false;clearInterval(pollTimer);cancelAnimationFrame(sizeFrame);for(const handler of pending.values()){const e=new Error(t.error);e.code="DECISION_TEARDOWN";handler.reject(e)}pending.clear();if(message.id!==undefined)window.parent.postMessage({jsonrpc:"2.0",id:message.id,result:{}},"*");return}if(Object.prototype.hasOwnProperty.call(message,"id")&&pending.has(message.id)){const handler=pending.get(message.id);pending.delete(message.id);if(message.error){const e=new Error(errorText(message.error));e.code="MCP_RPC_RESPONSE_ERROR";handler.reject(e)}else handler.resolve(message.result);return}if(message.method==="ui/notifications/tool-result")accept(message.params)},{passive:true});
    window.addEventListener("openai:set_globals",event=>{const globals=event&&event.detail&&event.detail.globals||{};if(Object.prototype.hasOwnProperty.call(globals,"toolResponseMetadata"))accept(globals.toolResponseMetadata);if(Object.prototype.hasOwnProperty.call(globals,"toolOutput"))accept(globals.toolOutput)});
    if(typeof ResizeObserver==="function")new ResizeObserver(()=>queueSizeChanged()).observe(document.body);window.addEventListener("resize",()=>queueSizeChanged(),{passive:true});
    void initialize();
  </script>
</body>
</html>`;
