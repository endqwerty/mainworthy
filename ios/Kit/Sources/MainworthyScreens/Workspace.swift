import Foundation
import MainworthyClient
import Observation

/// A screen of one project: what it shows can be read again, which the workspace asks for when the project's
/// change stream opens and whenever it tells of a change.
@MainActor
public protocol ProjectScreen: AnyObject {
	func refresh() async
}

/// What a signed-in person works in: their account, the project that is open, and that project's screens.
///
/// A screen belongs to one project. Opening another project makes new screens, so nothing read in one project
/// is ever shown, or answered, in another.
@MainActor @Observable
public final class Workspace {
	public private(set) var account: Account
	/// The address of the instance, as the person typed it.
	public let instanceName: String
	public private(set) var project: Project?
	public private(set) var queue: QueueScreen?
	public private(set) var runs: RunsScreen?
	public private(set) var changes: ChangesScreen?
	@ObservationIgnored public private(set) lazy var sessions = SessionsScreen(server: server) { [weak self] in
		await self?.signOut()
	}

	/// Every screen of the open project. What the change stream tells of, each of them reads again.
	private var screens: [any ProjectScreen] = []
	private let server: Server
	private let remembered: Remembered
	private let onSignedOut: () -> Void

	init(server: Server, account: Account, remembered: Remembered, onSignedOut: @escaping () -> Void) {
		self.server = server
		self.account = account
		self.remembered = remembered
		self.onSignedOut = onSignedOut
		instanceName = server.instance.name
		let last = account.projects.first { $0.key == remembered.project }
		if let first = last ?? account.projects.first { open(first) }
	}

	public func open(_ project: Project) {
		guard project != self.project else { return }
		self.project = project
		remembered.project = project.key
		let queue = QueueScreen(project: server.project(project.key))
		self.queue = queue
		let runs = RunsScreen(project: server.project(project.key), permission: project, person: account.name)
		self.runs = runs
		let changes = ChangesScreen(project: server.project(project.key))
		self.changes = changes
		screens = [queue, runs, changes]
	}

	/// Reads who is signed in and what they may open again: when the app comes to the front. A project can be
	/// taken away, or renamed, while the app was in the background.
	public func refreshAccount() async {
		guard let fresh = try? await server.account() else { return }
		account = fresh
		if let open = project, let now = fresh.projects.first(where: { $0.key == open.key }) {
			project = now
			runs?.updatePermission(now)
		} else if let first = fresh.projects.first {
			open(first)
		} else {
			project = nil
			queue = nil
			runs = nil
			changes = nil
			screens = []
		}
	}

	/// Follows the open project's change stream until the task is cancelled, reading the screens again when
	/// the stream opens and at each change. The stream replays nothing, so the read that makes a screen
	/// current is the one after the stream is open: a write between an earlier read and the opening is in it.
	/// A stream that breaks, or does not open, is opened again after a pause that grows to half a minute, and
	/// the screens are read at each try, so that a server whose stream does not work is still followed.
	public func follow() async {
		guard let key = project?.key else { return }
		var failures = 0
		while !Task.isCancelled {
			do {
				for try await _ in server.project(key).changes() {
					failures = 0
					for screen in screens { await screen.refresh() }
				}
			} catch {}
			failures += 1
			guard (try? await Task.sleep(for: .seconds(min(30, 2 << min(failures, 4))))) != nil else { return }
			for screen in screens { await screen.refresh() }
		}
	}

	/// Where the web app shows something, for what this build does not do: a question (Q-12), a run (R-4), a
	/// case (C-311). Nil for a ref of another kind.
	public func webAddress(of ref: String) -> URL? {
		guard let key = project?.key, let dash = ref.firstIndex(of: "-") else { return nil }
		let number = ref[ref.index(after: dash)...]
		let page: String
		switch ref[..<dash] {
		case "Q": page = "queue/\(number)"
		case "R": page = "runs/\(number)"
		case "C": page = "suite/c/\(number)"
		default: return nil
		}
		return server.instance.url.appending(path: "/p/\(key)/\(page)")
	}

	/// The documentation the instance serves.
	public var docsAddress: URL { server.instance.url.appending(path: "/docs") }

	/// Whether this workspace talks to this very server, so that a session renewed on it can take it back.
	func isOn(_ server: Server) -> Bool {
		self.server === server
	}

	public func signOut() async {
		await server.signOut()
		onSignedOut()
	}
}
