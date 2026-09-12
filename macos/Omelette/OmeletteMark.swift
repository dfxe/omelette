import SwiftUI

/// The folded Omelette mark shared by the app menu and its About view.
struct OmeletteMark: View {
    var body: some View {
        GeometryReader { proxy in
            let scale = min(proxy.size.width, proxy.size.height) / 16
            Path { path in
                path.move(to: CGPoint(x: 8, y: 1.75))
                path.addCurve(
                    to: CGPoint(x: 15.25, y: 9),
                    control1: CGPoint(x: 12.05, y: 1.75),
                    control2: CGPoint(x: 15.25, y: 4.95)
                )
                path.addCurve(
                    to: CGPoint(x: 10, y: 14.25),
                    control1: CGPoint(x: 15.25, y: 11.95),
                    control2: CGPoint(x: 12.95, y: 14.25)
                )
                path.addLine(to: CGPoint(x: 6, y: 14.25))
                path.addCurve(
                    to: CGPoint(x: 0.75, y: 9),
                    control1: CGPoint(x: 3.05, y: 14.25),
                    control2: CGPoint(x: 0.75, y: 11.95)
                )
                path.addCurve(
                    to: CGPoint(x: 8, y: 1.75),
                    control1: CGPoint(x: 0.75, y: 4.95),
                    control2: CGPoint(x: 3.95, y: 1.75)
                )
                path.closeSubpath()

                path.move(to: CGPoint(x: 4.15, y: 11.75))
                path.addCurve(
                    to: CGPoint(x: 12.15, y: 4.05),
                    control1: CGPoint(x: 5.35, y: 7.9),
                    control2: CGPoint(x: 8.15, y: 5.05)
                )
                path.addCurve(
                    to: CGPoint(x: 6.7, y: 11.75),
                    control1: CGPoint(x: 9.35, y: 6.05),
                    control2: CGPoint(x: 7.55, y: 8.65)
                )
                path.closeSubpath()
            }
            .applying(CGAffineTransform(scaleX: scale, y: scale))
            .fill(Color.accentColor, style: FillStyle(eoFill: true))
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .accessibilityLabel("Omelette")
    }
}
