import CodexBridgeKit
import SwiftUI

struct CodexAccountUsageView: View {
    @EnvironmentObject private var model: AppModel
    let account: CodexAccountUsage
    var runtimeKind: String? = nil
    @State private var showBilling = false
    @State private var adminKey = ""
    @State private var organizationId = ""
    @State private var projectId = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            LabeledContent("인증 방식", value: account.authMode == "api-key" ? "OpenAI API Key" : account.authMode == "chatgpt" ? "ChatGPT" : "—")
            if account.authMode == "chatgpt" {
                Text("같은 계정의 Codex 사용량은 앱·CLI·SDK에서 공유됩니다.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(sortedWindows) { window in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(Duration.seconds(Int64(window.windowDurationMins * 60)).formatted(.units(allowed: [.days, .hours, .minutes], width: .abbreviated)))
                            Text(window.displayName ?? BridgeAppLocalization.string("추가 사용량", locale: model.interfaceLocale)).foregroundStyle(.secondary)
                            Spacer()
                            Text(window.remainingPercent / 100, format: .percent.precision(.fractionLength(0)))
                            Text("남음")
                        }
                        ProgressView(value: max(0, min(100, window.remainingPercent)), total: 100)
                        if let reset = window.resetsAt {
                            HStack {
                                Text("초기화")
                                Text(Date(timeIntervalSince1970: reset), style: .relative)
                            }.font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if account.windows.isEmpty { Text("사용량 정보를 확인할 수 없습니다.").font(.caption) }
                if let credits = account.credits {
                    LabeledContent("추가 크레딧") {
                        if credits.unlimited {
                            Text("크레딧 제한 없음")
                        } else {
                            Text(verbatim: credits.balance ?? "—")
                        }
                    }
                    .help("잔액만으로 크레딧 사용 이력을 알 수는 없습니다.")
                }
                if let credits = account.resetCredits, credits.availableCount > 0 {
                    LabeledContent("사용량 초기화 쿠폰", value: credits.availableCount.formatted())
                }
                HStack {
                    Text("마지막 확인")
                    Spacer()
                    Text(Date(timeIntervalSince1970: account.observedAt / 1000), style: .relative)
                }.font(.caption).foregroundStyle(.secondary)
            } else if account.authMode == "api-key" {
                Text("API에도 요청·토큰·조직별 한도가 적용됩니다.")
                    .font(.caption).foregroundStyle(.secondary)
                Text("청구 금액은 실행 키로 조회할 수 없습니다.")
                    .font(.caption).foregroundStyle(.secondary)
                Link("API 사용량 및 비용 보기", destination: URL(string: "https://platform.openai.com/usage")!)
                if let costs = account.billing?.actualCosts, costs.configured {
                    if costs.status == "available", let usd = costs.usd {
                        LabeledContent(costs.projectId == nil ? "이번 달 조직 비용 (UTC)" : "이번 달 프로젝트 비용 (UTC)", value: usd.formatted(.currency(code: "USD")))
                    } else { Text("비용 정보를 확인할 수 없습니다.").font(.caption) }
                    Text("이 브리지의 작업 외 비용도 포함됩니다.").font(.caption).foregroundStyle(.secondary)
                    if let organization = costs.organizationId { Text(verbatim: organization).font(.caption) }
                    if let project = costs.projectId { Text(verbatim: project).font(.caption) }
                }
                if let runtimeKind {
                    FullRowDisclosure("API 비용 연결", isExpanded: $showBilling) {
                        Text("비용 조회용 관리자 키를 별도로 사용합니다. 실행 로그인은 변경하지 않습니다.")
                            .font(.caption).foregroundStyle(.secondary)
                        SecureField("OpenAI Admin API Key", text: $adminKey)
                        TextField("조직 ID", text: $organizationId)
                        TextField("프로젝트 ID (선택)", text: $projectId)
                        Button("비용 조회 연결") {
                            let input = CodexBillingInput(adminKey: adminKey, organizationId: organizationId.trimmingCharacters(in: .whitespacesAndNewlines),
                                projectId: projectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : projectId.trimmingCharacters(in: .whitespacesAndNewlines))
                            adminKey = ""
                            Task { await model.manageCodex(.init(action: "configure-billing", kind: runtimeKind, billing: input)) }
                        }.disabled(adminKey.isEmpty || organizationId.isEmpty)
                        if account.billing?.actualCosts?.configured == true {
                            Button("비용 연결 해제") { Task { await model.manageCodex(.init(action: "remove-billing", kind: runtimeKind)) } }
                        }
                    }
                }
            } else {
                Text("로그인이 필요합니다").foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var sortedWindows: [CodexAccountUsage.Window] {
        account.windows.sorted { left, right in
            if (left.limitId == "codex") != (right.limitId == "codex") { return left.limitId == "codex" }
            if left.limitId != right.limitId { return left.limitId < right.limitId }
            return left.windowDurationMins > right.windowDurationMins
        }
    }
}
