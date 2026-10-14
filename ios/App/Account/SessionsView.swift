import MainworthyClient
import MainworthyScreens
import SwiftUI

struct SessionsView: View {
	let screen: SessionsScreen
	@State private var chosen: PersonSession?

	private var confirming: Binding<Bool> {
		Binding(get: { chosen != nil }, set: { if !$0 { chosen = nil } })
	}

	var body: some View {
		Group {
			switch screen.loading {
			case .first: ProgressView()
			case .failed(let why):
				ContentUnavailableView {
					Label("Sessions could not be read", systemImage: "exclamationmark.triangle")
				} description: { Text(why) } actions: {
					Button("Try again") { Task { await screen.refresh() } }
				}
			case .done:
				List {
					if let notice = screen.notice { Text(notice).accessibilityIdentifier("sessions-notice") }
					if screen.sessions.isEmpty { Text("No session is signed in.").foregroundStyle(.secondary) }
					ForEach(screen.sessions) { session in
						Section {
							VStack(alignment: .leading, spacing: 8) {
								Text(session.client).font(.headline)
								if session.current {
									Tag(text: "this device", tint: .pass).accessibilityIdentifier("current-session")
								}
								Text("Opened with \(session.proof.name) · \(session.label)").font(.subheadline)
								Text("Opened \(date(session.openedAt))\(from(session.openedFrom))")
								Text("Last used \(date(session.lastUsedAt))\(from(session.lastUsedFrom))")
								Text("Ends by \(date(session.expiresAt))")
							}
							.font(.footnote)
							Button("End session", role: .destructive) { chosen = session }
								.disabled(screen.busy.contains(session.id))
								.accessibilityIdentifier("end-session-\(session.id)")
						}
					}
				}
				.refreshable { await screen.refresh() }
			}
		}
		.navigationTitle("Your sessions")
		.navigationBarTitleDisplayMode(.inline)
		.task { await screen.refresh() }
		.confirmationDialog(
			chosen?.current == true ? "End this device's session and sign out?" : "End this session?",
			isPresented: confirming, titleVisibility: .visible, presenting: chosen
		) { session in
			Button("End session", role: .destructive) {
				chosen = nil
				Task { await screen.end(session) }
			}
			Button("Cancel", role: .cancel) { chosen = nil }
		} message: { session in
			Text("\(session.client) will need to sign in again.")
		}
	}

	private func date(_ value: Date) -> String { value.formatted(date: .abbreviated, time: .shortened) }

	private func from(_ address: String?) -> String { address.map { " from \($0)" } ?? "" }
}
