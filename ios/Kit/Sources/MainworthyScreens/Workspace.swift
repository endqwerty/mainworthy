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
	@ObservationIgnored public private(set) lazy var tokens = TokensScreen(server: server)
	public private(set) var suite: SuiteScreen?
	public private(set) var tests: TestsScreen?

	/// Every screen of the open project. What the change stream tells of, each of them reads again.
	private var screens: [any ProjectScreen] = []
	private var outboxes: [String: AnswerOutbox] = [:]
	private let server: Server
	private let remembered: Remembered
	private let onSignedOut: () -> Void

	init(server: Server, account: Account, remembered: Remembered, onSignedOut: @escaping () -> Void) {
		self.server = server
		self.account = account
		self.remembered = remembered
		self.onSignedOut = onSignedOut
		instanceName = server.instance.name
		for project in account.projects { outboxes[project.id] = makeOutbox(project) }
		let last = account.projects.first { $0.key == remembered.project }
		if let first = last ?? account.projects.first { open(first) }
	}

	public func open(_ project: Project) {
		guard project != self.project else { return }
		self.project = project
		remembered.project = project.key
		let outbox = outboxes[project.id] ?? makeOutbox(project)
		outboxes[project.id] = outbox
		let queue = QueueScreen(project: server.project(project.key, identity: project.id), outbox: outbox)
		self.queue = queue
		let runs = RunsScreen(project: server.project(project.key, identity: project.id), permission: project, person: account.name)
		self.runs = runs
		let changes = ChangesScreen(project: server.project(project.key, identity: project.id))
		self.changes = changes
		let suite = SuiteScreen(project: server.project(project.key, identity: project.id))
		self.suite = suite
		let tests = TestsScreen(project: server.project(project.key, identity: project.id))
		self.tests = tests
		screens = [queue, runs, suite, changes, tests]
	}

	/// Reads who is signed in and what they may open again: when the app comes to the front. A project can be
	/// taken away, or renamed, while the app was in the background.
	public func refreshAccount() async {
		guard let fresh = try? await server.account() else { return }
		for key in Array(outboxes.keys) where !fresh.projects.contains(where: { $0.id == key }) {
			let outbox = outboxes.removeValue(forKey: key)
			let previous = account.projects.first { $0.id == key }
			if let previous, fresh.projects.contains(where: { $0.key == previous.key && $0.id != key }) { outbox?.retire() }
			else { outbox?.stop() }
		}
		for project in fresh.projects where outboxes[project.id] == nil {
			outboxes[project.id] = makeOutbox(project)
		}
		account = fresh
		if let open = project, let now = fresh.projects.first(where: { $0.key == open.key }) {
			if now.id != open.id { self.open(now) }
			else { project = now; runs?.updateSignedIn(now, as: fresh.name) }
		} else if let first = fresh.projects.first {
			open(first)
		} else {
			project = nil
			queue = nil
			runs = nil
			changes = nil
			suite = nil
			tests = nil
			screens = []
		}
	}

	/// Follows the open project's change stream until the task is cancelled, reading the screens again when
	/// the stream opens and at each change. The stream replays nothing, so the read that makes a screen
	/// current is the one after the stream is open: a write between an earlier read and the opening is in it.
	/// A stream that breaks, or does not open, is opened again after a pause that grows to half a minute, and
	/// the screens are read at each try, so that a server whose stream does not work is still followed.
	public func follow() async {
		guard let project else { return }
		var failures = 0
		while !Task.isCancelled {
			do {
				for try await _ in server.project(project.key, identity: project.id).changes() {
					failures = 0
					await refreshScreens()
				}
			} catch {}
			failures += 1
			guard (try? await Task.sleep(for: .seconds(min(30, 2 << min(failures, 4))))) != nil else { return }
			await refreshScreens()
		}
	}

	private func makeOutbox(_ project: Project) -> AnswerOutbox {
		AnswerOutbox(
			project: server.project(project.key, identity: project.id),
			store: FileAnswerStore(instance: server.instance, person: account.actorId, project: project.key, identity: project.id),
			now: {
				#if DEBUG
				let arguments = ProcessInfo.processInfo.arguments
				if let index = arguments.firstIndex(of: "-answer-clock-offset"), arguments.indices.contains(index + 1),
					let offset = TimeInterval(arguments[index + 1]), offset.isFinite {
					return Date().addingTimeInterval(offset)
				}
				#endif
				return Date()
			}
		)
	}

	private func refreshScreens() async {
		// All accessible projects send, including a project left while its answer was waiting.
		for key in outboxes.keys.sorted() { await outboxes[key]?.send() }
		for screen in screens { await screen.refresh() }
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
		case "T": page = "tests/\(number)"
		default: return nil
		}
		return server.instance.url.appending(path: "/p/\(key)/\(page)")
	}

	/// The documentation the instance serves.
	public var docsAddress: URL { server.instance.url.appending(path: "/docs") }

	public var privacyAddress: URL { server.instance.url.appending(path: "/privacy") }

	/// Whether this workspace talks to this very server, so that a session renewed on it can take it back.
	func isOn(_ server: Server) -> Bool {
		self.server === server
	}

	func pauseAnswers() {
		for outbox in outboxes.values { outbox.stop() }
	}

	func resumeAnswers() {
		for outbox in outboxes.values { outbox.resume() }
	}

	public func signOut() async {
		pauseAnswers()
		await server.signOut()
		onSignedOut()
	}
}
