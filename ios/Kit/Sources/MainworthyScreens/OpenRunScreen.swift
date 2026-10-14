import Foundation
import MainworthyClient
import Observation

/// One open run, with the case a person is executing and the last result they may correct with Undo.
@MainActor @Observable
public final class OpenRunScreen: ProjectScreen {
	public enum Document: Equatable {
		case none
		case reading(Int)
		case read(RunExecution)
		case failed(RunSlot, String)
	}
	public private(set) var run: PlannedRun
	public private(set) var slots: [RunSlot] = []
	public private(set) var loading = RunsScreen.Loading.first
	public private(set) var document = Document.none
	public private(set) var busy = false
	public private(set) var notice: String?
	public private(set) var canUndo = false
	public var note: String {
		get { draftSlot.flatMap { drafts[$0]?.note } ?? "" }
		set { if let draftSlot { drafts[draftSlot, default: Draft()].note = newValue } }
	}
	public var failedStep: String? { draftSlot.flatMap { drafts[$0]?.failedStep } }
	public private(set) var permission: Project
	private let project: ProjectClient
	private let person: String
	private var reads = 0
	private var acceptedRead = 0
	private var latestRead: Task<Bool, Never>?
	private var documents = 0
	private var last: Saved?
	private var own: [Int: OwnResult] = [:]
	private var draftSlot: Int?
	private var drafts: [Int: Draft] = [:]

	private struct Draft {
		var note = ""
		var failedStep: String?
	}

	private struct OwnResult {
		let result: Int
		let outcome: FilledOutcome
		let note: String?
		let atStep: String?

		init(result: Int, outcome: FilledOutcome, note: String?, atStep: String?) {
			self.result = result
			self.outcome = outcome
			self.note = note
			self.atStep = atStep
		}

		init(_ fill: RunFill) {
			self.init(result: fill.result, outcome: fill.outcome, note: fill.note, atStep: fill.atStep)
		}
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

	private func read(slotsOnly: Bool = false) async -> Bool {
		reads += 1
		let mine = reads
		let task = Task { @MainActor in
			do {
				let fresh = slotsOnly ? nil : try await project.run(run.ref)
				let slots = try await project.slots(of: run.ref)
				guard mine == reads else { return false }
				if let fresh { run = fresh }
				self.slots = slots
				acceptedRead = mine
				loading = .done
				return true
			} catch is CancellationError {
			} catch {
				guard mine == reads else { return false }
				if loading == .done { notice = error.shown } else { loading = .failed(error.shown) }
			}
			return false
		}
		latestRead = task
		return await withTaskCancellationHandler {
			await task.value
		} onCancel: {
			task.cancel()
		}
	}

	public func execute(_ slot: RunSlot) async {
		guard !busy else { return }
		documents += 1
		let mine = documents
		document = .reading(slot.id)
		draftSlot = slot.id
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
		drafts[execution.slot.id, default: Draft()].failedStep = failedStep == step.id ? nil : step.id
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
				own[execution.slot.id] = OwnResult(
					result: result, outcome: .manual(outcome), note: sentNote,
					atStep: outcome == .fail ? sentStep : nil)
				last = Saved(execution: execution, result: result, previous: previous)
				canUndo = true
				notice =
					"\(execution.slot.caseRef ?? "Case") · \(outcome.label) recorded on pinned v\(execution.slot.version)."
				if note == sentNote { note = "" }
				if failedStep == sentStep { drafts[execution.slot.id, default: Draft()].failedStep = nil }
				// Every read, including this fallback, drops a reply that another read overtook.
				let before = reads
				if !(await read()) { _ = await read(slotsOnly: true) }
				// If the fallback was overtaken too, wait for that reader instead of using old slots.
				while acceptedRead <= before {
					let waitingFor = reads
					guard let latestRead else { return true }
					_ = await latestRead.value
					if waitingFor == reads && acceptedRead <= before { return true }
				}
				await advance()
				return true
			}
		} catch {
			notice = error.shown
			return false
		}
	}

	private func advance() async {
		while let next = firstUnfilled, loading == .done {
			documents += 1
			let mine = documents
			document = .reading(next.id)
			draftSlot = next.id
			do {
				let execution = try await project.execution(of: next, in: run.ref)
				guard mine == documents else { return }
				// A refresh can fill this slot while its pinned case is being read.
				guard firstUnfilled?.id == next.id else { continue }
				document = .read(execution)
			} catch {
				guard mine == documents else { return }
				guard firstUnfilled?.id == next.id else { continue }
				document = .failed(next, error.shown)
			}
			return
		}
		documents += 1
		document = .none
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
				failedStep: saved.previous?.atStep, corrects: saved.result
			) {
			case .refused(let why): notice = why
			case .recorded(let result):
				own[saved.execution.slot.id] = OwnResult(
					result: result, outcome: .manual(outcome),
					note: saved.previous?.note ?? "Withdrawn by the author", atStep: saved.previous?.atStep
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
				draftSlot = slot.id
				document = .read(try await project.execution(of: slot, in: run.ref))
			}
		} catch { notice = error.shown }
	}
}
