import MainworthyClient
import MainworthyScreens
import SwiftUI

struct TokensView: View {
	let screen: TokensScreen
	@State private var chosen: AccessToken?
	private var confirming: Binding<Bool> {
		Binding(get: { chosen != nil }, set: { if !$0 { chosen = nil } })
	}

	var body: some View {
		List {
			if let notice = screen.notice {
				Section {
					Text(notice).accessibilityIdentifier("tokens-notice")
					if screen.mayCheckAgain {
						Button("Check again") { Task { await screen.checkAgain() } }
					}
				}
			}
			switch screen.loading {
			case .first: ProgressView()
			case .failed(let why):
				Section {
					Text("Tokens could not be read").font(.headline)
					Text(why)
					Button("Read tokens again") { Task { await screen.refresh() } }
				}
			case .done:
				if screen.tokens.isEmpty { Text("No tokens.").foregroundStyle(.secondary) }
				ForEach(screen.tokens.reversed()) { token in
					Section {
						VStack(alignment: .leading, spacing: 8) {
							Text(token.label.isEmpty ? "Untitled token" : token.label).font(.headline)
							Text("#\(token.id) · \(token.actor) · \(token.kind)").font(.subheadline)
							Text(token.state.rawValue).accessibilityIdentifier("token-state-\(token.id)")
							Text("Created \(date(token.createdAt)) by \(token.createdBy ?? "instance startup")")
							if let used = token.lastUsedAt {
								Text("Last used \(date(used)) from \(token.lastUsedFrom ?? "an unknown address")")
							} else { Text("Never used") }
							if let expiry = token.expiresAt { Text("Expires \(date(expiry))") }
							else { Text("No expiry") }
						}
						.font(.footnote)
						if token.state != .revoked {
							Button("Revoke token", role: .destructive) { chosen = token }
								.disabled(!screen.mayRevoke)
								.accessibilityIdentifier("revoke-token-\(token.id)")
						}
					}
				}
			}
		}
		.navigationTitle("Tokens")
		.navigationBarTitleDisplayMode(.inline)
		.task { await screen.refresh() }
		.refreshable { await screen.refresh() }
		.confirmationDialog("Revoke \(chosen?.name ?? "token")?", isPresented: confirming,
			titleVisibility: .visible, presenting: chosen
		) { token in
			Button("Revoke token", role: .destructive) {
				chosen = nil
				Task { await screen.revoke(token) }
			}
			Button("Cancel", role: .cancel) { chosen = nil }
		} message: { token in
			Text("\(token.actor)'s token will stop working. Sessions opened with it will end. This app signed in with a password and will stay signed in.")
		}
	}

	private func date(_ value: Date) -> String { value.formatted(date: .abbreviated, time: .shortened) }
}
