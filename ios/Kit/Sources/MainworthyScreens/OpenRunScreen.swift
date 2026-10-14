import Foundation
import MainworthyClient
import Observation

/// One open run, with the case a person is executing and the last result they may correct with Undo.
@MainActor @Observable
public final class OpenRunScreen: ProjectScreen {
	public enum Document: Equatable {
		case none, reading(Int), read(RunExecution), failed(RunSlot, String)
	}
	public private(set) var run: PlannedRun
	public private(set) var slots: [RunSlot] = []
	public private(set) var loading = RunsScreen.Loading.first
	public private(set) var document = Document.none
	public private(set) var busy = false
	public private(set) var notice: String?
	public private(set) var canUndo = false
	public var note = ""
	public private(set) var failedStep: String?
	public private(set) var permission: Project
	private let project: ProjectClient
	private let person: String
	private var reads = 0
	private var documents = 0
	private var last: Saved?
	private var own: [Int: OwnResult] = [:]

	private struct OwnResult {
		let result: Int
		let outcome: FilledOutcome
		let note: String?

		init(result: Int, outcome: FilledOutcome, note: String?) {
			self.result = result
			self.outcome = outcome
			self.note = note
		}

		init(_ fill: RunFill) { self.init(result: fill.result, outcome: fill.outcome, note: fill.note) }
	}

	private struct Saved {
		let execution: RunExecution
		let result: Int
		let previous: OwnResult?
	}

	package init(project: ProjectClient, run: PlannedRun, permission: Project, person: String) {
		self.project = project
		self.run = run
		self.permission = permission
		self.person = person
	}

	package func updatePermission(_ permission: Project) { self.permission = permission }
	package func planned(_ sentence: String) { notice = sentence }
	public var firstUnfilled: RunSlot? { slots.first { $0.fills.isEmpty && $0.caseRef != nil } }
	public var isReadOnly: Bool { !permission.may(.produce) }
	public func mayRecord(_ execution: RunExecution) -> Bool {
		permission.may(.produce) && run.state == .open && execution.run == run.ref
			&& execution.content.methods.contains("human")
	}

	public func refresh() async { _ = await read() }

	private func read() async -> Bool {
		reads += 1
		let mine = reads
		do {
			let fresh = try await project.run(run.ref)
			let slots = try await project.slots(of: run.ref)
			guard mine == reads else { return false }
			run = fresh
			self.slots = slots
			loading = .done
			return true
		} catch is CancellationError {
		} catch {
			guard mine == reads else { return false }
			if loading == .done { notice = error.shown } else { loading = .failed(error.shown) }
		}
		return false
	}

	public func execute(_ slot: RunSlot) async {
		guard !busy else { return }
		documents += 1
		let mine = documents
		document = .reading(slot.id)
		note = ""
		failedStep = nil
		do {
			let execution = try await project.execution(of: slot, in: run.ref)
			guard mine == documents else { return }
			document = .read(execution)
		} catch is CancellationError {
		} catch { if mine == documents { document = .failed(slot, error.shown) } }
	}

	public func mark(_ step: Step) {
		guard !busy, case .read(let execution) = document, mayRecord(execution),
			execution.content.steps.contains(where: { $0.id == step.id })
		else { return }
		failedStep = failedStep == step.id ? nil : step.id
	}

	@discardableResult
	public func record(_ execution: RunExecution, outcome: ManualOutcome) async -> Bool {
		guard !busy, mayRecord(execution), case .read(let shown) = document, shown == execution else {
			return false
		}
		busy = true
		defer { busy = false }
		let sentNote = note
		let sentStep = failedStep
		let shownPrevious = execution.slot.ownFill(by: person).map(OwnResult.init)
		let local = own[execution.slot.id]
		let previous = (local?.result ?? 0) > (shownPrevious?.result ?? 0) ? local : shownPrevious
		let corrects = previous?.result
		do {
			switch try await project.report(
				execution, outcome: outcome, note: sentNote, failedStep: sentStep, corrects: corrects)
			{
			case .refused(let why):
				notice = why
				return false
			case .recorded(let result):
				own[execution.slot.id] = OwnResult(result: result, outcome: .manual(outcome), note: sentNote)
				last = Saved(execution: execution, result: result, previous: previous)
				canUndo = true
				notice =
					"\(execution.slot.caseRef ?? "Case") · \(outcome.label) recorded on pinned v\(execution.slot.version)."
				if note == sentNote { note = "" }
				if failedStep == sentStep { failedStep = nil }
				// The change stream tells of this very report, and the refresh it starts can overtake the read
				// made here, which is then dropped. The slots are read once more for the result's own sake: they
				// are the ones the server holds after the report, whoever else is reading, and the page must
				// not stay on the case that was just recorded.
				if !(await read()) {
					guard let after = try? await project.slots(of: run.ref) else { return true }
					slots = after
					loading = .done
				}
				// Selecting the next case happens only after the server confirms the result and its slots.
				if let next = firstUnfilled, loading == .done {
					documents += 1
					let mine = documents
					document = .reading(next.id)
					do {
						let nextExecution = try await project.execution(of: next, in: run.ref)
						if mine == documents { document = .read(nextExecution) }
					} catch { if mine == documents { document = .failed(next, error.shown) } }
				} else {
					document = .none
				}
				return true
			}
		} catch {
			notice = error.shown
			return false
		}
	}

	public func undo() async {
		guard !busy, let saved = last, mayRecord(saved.execution) else { return }
		let outcome: ManualOutcome
		if let previous = saved.previous {
			guard case .manual(let prior) = previous.outcome else {
				notice = "This build cannot restore that earlier outcome. Open the run in the web app."
				return
			}
			outcome = prior
		} else {
			outcome = .skip
		}
		busy = true
		defer { busy = false }
		do {
			switch try await project.report(
				saved.execution, outcome: outcome, note: saved.previous?.note ?? "Withdrawn by the author",
				corrects: saved.result
			) {
			case .refused(let why): notice = why
			case .recorded(let result):
				own[saved.execution.slot.id] = OwnResult(
					result: result, outcome: .manual(outcome),
					note: saved.previous?.note ?? "Withdrawn by the author"
				)
				last = nil
				canUndo = false
				notice =
					saved.previous == nil
					? "The result is corrected to skipped. A skipped slot counts as no proof."
					: "The earlier outcome is restored by a correction."
				await refresh()
				let slot = slots.first { $0.id == saved.execution.slot.id } ?? saved.execution.slot
				documents += 1
				document = .read(try await project.execution(of: slot, in: run.ref))
				note = ""
				failedStep = nil
			}
		} catch { notice = error.shown }
	}
}
