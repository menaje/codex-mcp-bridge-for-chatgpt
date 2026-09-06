import AppKit
import SwiftUI

enum BridgeBrandPalette {
    static let green = Color(
        red: 53.0 / 255.0,
        green: 220.0 / 255.0,
        blue: 122.0 / 255.0
    )
}

/// A small-size-optimized rendering of the node-and-core mark used by the app icon.
struct BridgeBrandMarkShape: Shape {
    func path(in rect: CGRect) -> Path {
        let dimension = min(rect.width, rect.height)
        let origin = CGPoint(
            x: rect.midX - dimension / 2,
            y: rect.midY - dimension / 2
        )
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: origin.x + x * dimension, y: origin.y + y * dimension)
        }
        func circle(_ x: CGFloat, _ y: CGFloat, radius: CGFloat) -> CGRect {
            CGRect(
                x: origin.x + (x - radius) * dimension,
                y: origin.y + (y - radius) * dimension,
                width: radius * 2 * dimension,
                height: radius * 2 * dimension
            )
        }

        var path = Path()
        for center in [(0.27, 0.28), (0.73, 0.28), (0.50, 0.75)] {
            path.addEllipse(in: circle(center.0, center.1, radius: 0.095))
            path.addEllipse(in: circle(center.0, center.1, radius: 0.055))
        }
        for center in [
            (0.37, 0.38), (0.43, 0.44),
            (0.63, 0.38), (0.57, 0.44),
            (0.50, 0.61), (0.50, 0.67)
        ] {
            path.addEllipse(in: circle(center.0, center.1, radius: 0.026))
        }
        path.move(to: point(0.50, 0.43))
        path.addLine(to: point(0.57, 0.50))
        path.addLine(to: point(0.50, 0.57))
        path.addLine(to: point(0.43, 0.50))
        path.closeSubpath()
        return path
    }
}

struct BridgeBrandMark: View {
    var color = BridgeBrandPalette.green

    var body: some View {
        BridgeBrandMarkShape()
            .fill(color, style: FillStyle(eoFill: true, antialiased: true))
            .aspectRatio(1, contentMode: .fit)
            .accessibilityHidden(true)
    }
}

/// The menu bar keeps the brand mark monochrome so macOS can adapt it to the
/// current appearance. Only an actionable state adds a compact status badge.
struct BridgeMenuBarIcon: View {
    let health: MenuBarHealth

    var body: some View {
        Image(nsImage: Self.templateImage(for: health))
            .renderingMode(.template)
            .resizable()
            .interpolation(.high)
            .frame(width: 18, height: 18)
    }

    static func templateImage(for health: MenuBarHealth) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: true) { rect in
            let context = NSGraphicsContext.current?.cgContext
            context?.saveGState()
            context?.setFillColor(NSColor.black.cgColor)
            context?.addPath(BridgeBrandMarkShape().path(in: rect).cgPath)
            context?.drawPath(using: .eoFill)

            switch health {
            case .healthy:
                break
            case .checking:
                context?.setStrokeColor(NSColor.black.cgColor)
                context?.setLineWidth(1.4)
                context?.strokeEllipse(in: CGRect(x: 13, y: 0.5, width: 5, height: 5))
            case .attention:
                context?.fillEllipse(in: CGRect(x: 13, y: 0.5, width: 5, height: 5))
            case .unavailable:
                context?.setStrokeColor(NSColor.black.cgColor)
                context?.setLineWidth(2.4)
                context?.setLineCap(.round)
                context?.move(to: CGPoint(x: 13.2, y: 1.2))
                context?.addLine(to: CGPoint(x: 17.2, y: 5.2))
                context?.strokePath()
            }
            context?.restoreGState()
            return true
        }
        image.isTemplate = true
        return image
    }
}

/// Branded identity for app content, with the operational state kept as a
/// separate badge instead of replacing the logo with an unrelated symbol.
struct BridgeBrandStatusIcon: View {
    let health: MenuBarHealth
    var size: CGFloat = 30

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            BridgeBrandMark()
                .frame(width: size, height: size)
            Image(systemName: badgeSymbol)
                .resizable()
                .scaledToFit()
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, badgeColor)
                .frame(width: size * 0.38, height: size * 0.38)
                .background {
                    Circle()
                        .fill(.background)
                        .padding(-1.5)
                }
                .accessibilityHidden(true)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var badgeSymbol: String {
        switch health {
        case .healthy: return "checkmark.circle.fill"
        case .checking: return "ellipsis.circle.fill"
        case .attention: return "exclamationmark.circle.fill"
        case .unavailable: return "xmark.circle.fill"
        }
    }

    private var badgeColor: Color {
        switch health {
        case .healthy: return .green
        case .checking: return .blue
        case .attention: return .orange
        case .unavailable: return .red
        }
    }
}

/// A disclosure control whose complete header row, including its title, is clickable.
/// SwiftUI's macOS disclosure label can otherwise feel like only the chevron is active.
struct FullRowDisclosure<Label: View, Content: View>: View {
    @Environment(\.locale) private var locale
    @Binding private var isExpanded: Bool
    private let label: Label
    private let content: Content

    init(
        isExpanded: Binding<Bool>,
        @ViewBuilder label: () -> Label,
        @ViewBuilder content: () -> Content
    ) {
        _isExpanded = isExpanded
        self.label = label()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .accessibilityHidden(true)
                    label
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(BridgeAppLocalization.string(
                isExpanded ? "펼침" : "접힘",
                locale: locale
            ))

            if isExpanded {
                content
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 6)
                    .padding(.leading, 18)
            }
        }
    }
}

extension FullRowDisclosure where Label == Text {
    init(
        _ title: LocalizedStringKey,
        isExpanded: Binding<Bool>,
        @ViewBuilder content: () -> Content
    ) {
        self.init(isExpanded: isExpanded, label: { Text(title) }, content: content)
    }
}
