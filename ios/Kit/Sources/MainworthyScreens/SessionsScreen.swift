import MainworthyClient
import Observation

/// The person's sessions on the instance, whichever project is open.
@MainActor @Observable
public final class SessionsScreen {
	public enum Loading: Equatable, Sendable {
		case first, done, failed(String)
	}

	public private(set) var sessions: [PersonSession] = []
	public private(set) var loading = Loading.first
	public private(set) var notice: String?
	public private(set) var busy: Set<Int> = []
	private let server: Server
	private var reads = 0
	private let signOut: @MainActor () async -> Void

	package init(server: Server, signOut: @escaping @MainActor () async -> Void) {
		self.server = server
		self.signOut = signOut
	}

	public func refresh() async {
		reads += 1
		let mine = reads
		do {
			let fresh = try await server.sessions()
			guard mine == reads else { return }
			sessions = fresh
			loading = .done
		} catch is CancellationError {
		} catch {
			guard mine == reads else { return }
			if loading == .done { notice = error.shown } else { loading = .failed(error.shown) }
		}
	}

	/// The confirmed row is kept by the view. Ending this device follows the workspace's sign-out path.
	public func end(_ session: PersonSession) async {
		guard busy.insert(session.id).inserted else { return }
		defer { busy.remove(session.id) }
		if session.current {
			await signOut()
			return
		}
		do {
			switch try await server.end(session) {
			case .ended: notice = "Session ended."
			case .alreadyEnded: notice = "That session has already ended."
			case .notEnded: notice = "The server did not end this session."
			case .signedOut:
				await signOut()
				return
			}
		} catch {
			notice = error.shown
		}
		await refresh()
	}
}
