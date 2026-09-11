import CodexBridgeKit
import SwiftUI

struct RuntimeLifecycleNoticeView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let operation = model.lifecycleOperation, operation.isPending || operation.phase == "failed" {
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Label(text(actionKey(operation.kind)), systemImage: operation.isExecuting ? "arrow.triangle.2.circlepath" : "clock")
                        .font(.caption.weight(.semibold))
                    Spacer()
                    if operation.cancellable {
                        Button("예약 취소") { Task { await model.cancelLifecycle() } }
                            .disabled(model.isBusy)
                    }
                }
                Text(operation.phase == "failed"
                    ? BridgeAppLocalization.lifecycleFailureDescription(operation.error, locale: model.interfaceLocale)
                    : text(phaseKey(operation)))
                    .font(.caption)
                ForEach(Array(operation.reasons.enumerated()), id: \.offset) { _, reason in
                    Text(reasonText(reason)).font(.caption).foregroundStyle(.secondary)
                }
                if let target = operation.targetDescription, !target.isEmpty {
                    Text(verbatim: target).font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("runtime-lifecycle-reservation")
        }
    }

    private func text(_ key: String) -> String { BridgeAppLocalization.string(key, locale: model.interfaceLocale) }

    private func actionKey(_ kind: String) -> String {
        switch kind {
        case "start": return "서버 시작 예약"
        case "restart": return "서버 재시작 예약"
        case "stop": return "서버 중지 예약"
        case "configure": return "설정 적용 예약"
        case "repair": return "프로필 복구 예약"
        case "shutdown": return "앱 종료 예약"
        case "mode-switch": return "원격 모드 전환 예약"
        default: return "helper 갱신 예약"
        }
    }

    private func phaseKey(_ operation: RuntimeLifecycleOperation) -> String {
        switch operation.phase {
        case "executing": return "안전하게 서버를 중지하고 있습니다."
        case "reconnecting": return "새 설정으로 연결을 확인하고 있습니다."
        case "handoff-ready", "handing-off": return "서버가 멈췄습니다. 앱에서 후속 처리를 마무리하고 있습니다."
        default: return "조건이 충족되면 자동으로 진행합니다. 대기 시간 제한은 없습니다."
        }
    }

    private func reasonText(_ reason: RuntimeLifecycleOperation.Reason) -> String {
        switch reason.code {
        case "active-jobs", "pending-admissions":
            return BridgeAppLocalization.format("진행 중이거나 시작 중인 작업: %d개", locale: model.interfaceLocale, reason.count ?? 0)
        case "memory-only-threads": return text("저장되지 않은 대화를 보호하고 있습니다. 연결 해제를 기다리거나 현황을 확인한 뒤 강제 적용하세요.")
        case "pending-interactions": return text("승인이나 답변을 기다리고 있습니다.")
        case "background-processes": return text("백그라운드 프로세스가 끝나기를 기다리고 있습니다.")
        case "background-state-unknown": return text("백그라운드 실행 상태를 확인하고 있습니다.")
        default: return text("실행 상태를 다시 확인하고 있습니다. 예약은 유지됩니다.")
        }
    }
}
