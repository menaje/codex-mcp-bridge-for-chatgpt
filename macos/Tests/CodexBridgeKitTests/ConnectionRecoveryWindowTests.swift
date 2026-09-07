import CodexBridgeKit
import XCTest

final class ConnectionRecoveryWindowTests: XCTestCase {
    func testTransientFailureRecoversWithoutDeclaringAnOutage() {
        var window = ConnectionRecoveryWindow()
        let start = Date(timeIntervalSince1970: 100)
        window.observe(available: true, retryable: true, at: start)
        window.observe(available: false, retryable: true, at: start.addingTimeInterval(1))
        XCTAssertTrue(window.isChecking)
        window.observe(available: true, retryable: true, at: start.addingTimeInterval(2))
        XCTAssertFalse(window.isChecking)
    }

    func testRepeatedOrCachedFailuresCannotExtendRecoveryIndefinitely() {
        var window = ConnectionRecoveryWindow()
        let start = Date(timeIntervalSince1970: 100)
        for elapsed in 0...10 {
            window.observe(available: false, retryable: true, at: start.addingTimeInterval(Double(elapsed)))
            XCTAssertEqual(window.isChecking, elapsed < 8)
        }
    }

    func testConfirmedProcessExitDoesNotWaitForRecoveryGrace() {
        var window = ConnectionRecoveryWindow()
        window.observe(available: false, retryable: true)
        XCTAssertTrue(window.isChecking)
        window.observe(available: false, retryable: false)
        XCTAssertFalse(window.isChecking)
    }

    func testWakeAndClockChangesStartAFreshBoundedWindow() {
        for adjustment in [60.0, -60.0] {
            var window = ConnectionRecoveryWindow()
            let start = Date(timeIntervalSince1970: 100)
            window.observe(available: false, retryable: true, at: start)
            window.observe(available: false, retryable: true, at: start.addingTimeInterval(8))
            XCTAssertFalse(window.isChecking)
            let wake = start.addingTimeInterval(adjustment)
            window.observe(available: false, retryable: true, at: wake)
            XCTAssertTrue(window.isChecking)
            window.observe(available: false, retryable: true, at: wake.addingTimeInterval(8))
            XCTAssertFalse(window.isChecking)
        }
    }
}
