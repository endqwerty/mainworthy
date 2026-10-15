import MainworthyClient
import Observation

/// Token administration belongs to the instance, and keeps its pending command across project switches.
@MainActor @Observable
public final class TokensScreen {
	public enum Loading: Equatable, Sendable { case first, done, failed(String) }
	public enum Action: Equatable, Sendable {
		case none, sending(AccessToken), unknown(AccessToken, String)
		case revoked(AccessToken), alreadyRevoked(AccessToken), refused(AccessToken, String)
	}

	public private(set) var tokens: [AccessToken] = []
	public private(set) var loading = Loading.first
	public private(set) var action = Action.none
	private let server: Server
	private var reads = 0
	private var pending: TokenRevocation?

	package init(server: Server) { self.server = server }

	public var mayRevoke: Bool { pending == nil }
	public var mayCheckAgain: Bool { if case .unknown = action { true } else { false } }
	public var notice: String? {
		switch action {
		case .none: nil
		case .sending(let token): "Revoking \(token.name)…"
		case .unknown(let token, let why): "Outcome unknown for \(token.name). \(why) Check again to learn the result."
		case .revoked(let token): "Revoked \(token.name)."
		case .alreadyRevoked(let token): "Already revoked \(token.name)."
		case .refused(let token, let why): "Could not revoke \(token.name). \(why)"
		}
	}

	public func refresh() async {
		reads += 1
		let mine = reads
		do {
			let fresh = try await server.tokens()
			guard mine == reads else { return }
			tokens = fresh
			loading = .done
		} catch {
			guard mine == reads else { return }
			loading = .failed(error.shown)
		}
	}

	public func revoke(_ token: AccessToken) async {
		guard mayRevoke else { return }
		let submission = TokenRevocation(token)
		pending = submission
		await send(submission, recovering: false)
	}

	public func checkAgain() async {
		guard mayCheckAgain, let pending else { return }
		await send(pending, recovering: true)
	}

	private func send(_ submission: TokenRevocation, recovering: Bool) async {
		reads += 1
		action = .sending(submission.token)
		do {
			let revoked = try await server.revoke(submission)
			pending = nil
			action = revoked ? .revoked(submission.token) : .alreadyRevoked(submission.token)
		} catch {
			if !recovering, case ClientError.refused = error {
				pending = nil
				action = .refused(submission.token, error.shown)
			} else {
				action = .unknown(submission.token, error.shown)
			}
		}
		await refresh()
	}
}
