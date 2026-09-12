import AppKit
import XCTest
@testable import CodexBridgeMenuBar

final class BrandIconTests: XCTestCase {
    @MainActor
    func testMenuBarIconsKeepTransparentMarginsAtBothDisplayScales() throws {
        for health in [MenuBarHealth.healthy, .checking, .attention, .unavailable] {
            for scale in [1, 2] {
                let pixels = 18 * scale
                let bitmap = try XCTUnwrap(NSBitmapImageRep(
                    bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                    isPlanar: false, colorSpaceName: .deviceRGB,
                    bytesPerRow: 0, bitsPerPixel: 0
                ))
                bitmap.size = NSSize(width: 18, height: 18)
                let context = try XCTUnwrap(NSGraphicsContext(bitmapImageRep: bitmap))
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = context
                BridgeMenuBarIcon.templateImage(for: health).draw(
                    in: CGRect(x: 0, y: 0, width: 18, height: 18),
                    from: .zero, operation: .copy, fraction: 1
                )
                NSGraphicsContext.restoreGraphicsState()

                var visiblePixels = 0
                for y in 0..<pixels {
                    for x in 0..<pixels {
                        let alpha = try XCTUnwrap(bitmap.colorAt(x: x, y: y)).alphaComponent
                        if alpha > 0 { visiblePixels += 1 }
                        if x == 0 || y == 0 || x == pixels - 1 || y == pixels - 1 {
                            XCTAssertEqual(alpha, 0, accuracy: 0.001,
                                           "\(health), \(scale)x: drawing reaches the edge at (\(x), \(y))")
                        }
                    }
                }
                // A blank image or an opaque tile must not satisfy the margin check.
                XCTAssertGreaterThan(visiblePixels, pixels * pixels / 20)
                XCTAssertLessThan(visiblePixels, pixels * pixels / 2)
            }
        }
    }
}
