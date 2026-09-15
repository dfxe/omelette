import SwiftUI

/// The skillet icon shared by the app menu and its About view.
struct OmeletteMark: View {
    var body: some View {
        Image("omelette", bundle: .main)
            .renderingMode(.original)
            .resizable()
            .scaledToFit()
            .accessibilityLabel("Omelette")
    }
}
