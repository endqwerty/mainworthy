import Foundation
import MainworthyClient
import Observation

/// One open run, with the case a person is executing and the last result they may correct with Undo.
@MainActor @Observable
public final class OpenRunScreen: ProjectScreen {
	public let attachments: ResultAttachmentScreen
	public enum Document: Equatable {
		case none
		case reading(Int)
		case read(RunExecution)
		case failed(RunSlot, String)
	}
	public private(set) var run: Run
	public private(set) var slots: [RunSlot] = []
	public private(set) var loading = ListLoading.first
	public private(set) var document = Document.none
	public private(set) var busy = false
	public private(set) var notice: String?
	public var canUndo: Bool { last != nil }
	public var hasPendingReport: Bool { !pending.isEmpty }
	public func hasPendingReport(for execution: RunExecution) -> Bool { pending[execution.slot.id] != nil }
	public func latestSlot(_ execution: RunExecution) -> RunSlot {
		slots.first { $0.id == execution.slot.id } ?? execution.slot
	}
	public var note: String {
		get { draftSlot.flatMap { drafts[$0]?.note } ?? "" }
		set { if let draftSlot { drafts[draftSlot, default: Draft()].note = newValue } }
	}
	public var failedStep: String? { draftSlot.flatMap { drafts[$0]?.failedStep } }
	public private(set) var permission: Project
	private let project: ProjectClient
	private var person: String
	private var reads = 0
	private var acceptedRead = 0
	private enum ReadResult { case accepted, superseded, failed }
	private var latestRead: Task<ReadResult, Never>?
	private var documents = 0
	private var last: Saved?
	private var own: [Int: OwnResult] = [:]
	private var draftSlot: Int?
	private var drafts: [Int: Draft] = [:]
	private var pending: [Int: Pending] = [:]
	private struct Pending {
		let submission: RunReportSubmission
		let previous: OwnResult?
		let isUndo: Bool
		var resendRefusal: String?
	}

	private struct Draft {
		var note = ""
		var failedStep: String?
	}

	private struct OwnResult {
		let result: Int
		let outcome: FilledOutcome
		let note: String?
		let atStep: String?
		let steps: [ResultStep]?

		init(result: Int, outcome: FilledOutcome, note: String?, atStep: String?, steps: [ResultStep]?) {
			self.result = result
			self.outcome = outcome
			self.note = note
			self.atStep = atStep
			self.steps = steps
		}

		init(_ fill: RunFill) {
			self.init(result: fill.result, outcome: fill.outcome, note: fill.note, atStep: fill.atStep, steps: fill.steps)
		}
	}

	private struct Saved {
		let execution: RunExecution
		let result: Int
		let previous: OwnResult?
	}

	package init(project: ProjectClient, run: Run, permission: Project, person: String) {
		self.project = project
		attachments = ResultAttachmentScreen(project: project)
		self.run = run
		self.permission = permission
		self.person = person
	}

	package func updateSignedIn(_ permission: Project, as person: String) {
		self.permission = permission
		self.person = person
	}
	package func planned(_ sentence: String) { notice = sentence }
	public var firstUnfilled: RunSlot? {
		slots.first { $0.needsProof && $0.ownFill(by: person) == nil && $0.caseRef != nil }
	}
	public var isReadOnly: Bool { !permission.may(.record) }
	/// Leave completed or failing external evidence to its producer. Missing proof stays open to another person.
	/// Read from the latest slots, so a fill that arrives counts.
	public func isLeftToOthers(_ slot: RunSlot) -> Bool {
		let latest = slots.first { $0.id == slot.id } ?? slot
		return !latest.needsProof && !latest.fills.isEmpty && latest.ownFill(by: person) == nil
	}
	public func mayRecord(_ execution: RunExecution) -> Bool {
		permission.may(.record) && run.state == .open && execution.run == run.ref
			&& execution.content.methods.contains("human") && !isLeftToOthers(execution.slot)
	}

	public func refresh() async { _ = await read() }

	private func read(slotsOnly: Bool = false) async -> ReadResult {
		reads += 1
		let mine = reads
		let task = Task<ReadResult, Never> { @MainActor in
			do {
				let fresh = slotsOnly ? nil : try await project.run(run.ref)
				let slots = try await project.slots(of: run.ref)
				guard mine == reads else { return .superseded }
				if let fresh { run = fresh }
				self.slots = slots
				if let saved = last, pending[saved.execution.slot.id] == nil,
					slots.first(where: { $0.id == saved.execution.slot.id })?.ownFill(by: person)?.result != saved.result {
					last = nil
				}
				acceptedRead = mine
				loading = .done
				return .accepted
			} catch is CancellationError {
			} catch {
				guard mine == reads else { return .superseded }
				if loading == .done { notice = error.shown } else { loading = .failed(error.shown) }
			}
			return mine == reads ? .failed : .superseded
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
		guard !busy, case .read(let execution) = document, mayRecord(execution), !hasPendingReport(for: execution),
			execution.content.steps.contains(where: { $0.id == step.id })
		else { return }
		drafts[execution.slot.id, default: Draft()].failedStep = failedStep == step.id ? nil : step.id
	}

	@discardableResult
	public func record(_ execution: RunExecution, outcome: ManualOutcome) async -> Bool {
		guard !busy else { return false }
		if let waiting = pending[execution.slot.id] { return await send(waiting, recovering: true) }
		guard mayRecord(execution), case .read(let shown) = document, shown == execution else { return false }
		busy = true
		defer { busy = false }
		let known = latestSlot(execution).ownFill(by: person).map(OwnResult.init)
		let local = own[execution.slot.id]
		let previous = (local?.result ?? 0) > (known?.result ?? 0) ? local : known
		do {
			let submission = try await project.prepareReport(execution, outcome: outcome, note: note,
				failedStep: failedStep, corrects: previous?.result)
			let waiting = Pending(submission: submission, previous: previous, isUndo: false)
			pending[execution.slot.id] = waiting
			return await deliver(waiting, recovering: false)
		} catch { notice = error.shown; return false }
	}

	public func retryReport() async {
		guard !busy else { return }
		let selected = draftSlot.flatMap { pending[$0] } ?? pending.sorted { $0.key < $1.key }.first?.value
		if let selected { _ = await send(selected, recovering: true) }
	}

	public func canSetAsideReport(_ execution: RunExecution) -> Bool {
		pending[execution.slot.id]?.resendRefusal != nil
	}

	/// Called only after confirmation that an earlier attempt may still have been recorded.
	public func setAsideReport(_ execution: RunExecution) async {
		guard !busy, canSetAsideReport(execution) else { return }
		busy = true
		defer { busy = false }
		switch await read() {
		case .accepted: break
		case .superseded: return
		case .failed:
			notice = "The run could not be read. The report was kept. Retry or try setting it aside again."
			return
		}
		pending[execution.slot.id] = nil
		own[execution.slot.id] = nil
		if last?.execution.slot.id == execution.slot.id { last = nil }
		notice = "The report is set aside on this device. It may still have been recorded. The slot shows the latest results read from the server."
		await showCorrected(execution)
	}

	private func send(_ waiting: Pending, recovering: Bool) async -> Bool {
		busy = true
		defer { busy = false }
		return await deliver(waiting, recovering: recovering)
	}

	private func deliver(_ waiting: Pending, recovering: Bool) async -> Bool {
		let submission = waiting.submission
		let execution = submission.execution
		do {
			switch try await project.report(submission, recovering: recovering) {
			case .resendRefused(let why):
				pending[execution.slot.id]?.resendRefusal = why
				notice = "The server refused this report's resend. \(why)\nThe earlier attempt may still have been recorded. Retry the same report or set it aside for this slot."
				return false
			case .refused(let why):
				pending[execution.slot.id] = nil
				notice = why
				return false
			case .recorded(let result):
				pending[execution.slot.id] = nil
				own[execution.slot.id] = OwnResult(result: result, outcome: .manual(submission.outcome),
					note: submission.note, atStep: submission.outcome == .fail ? submission.failedStep : nil, steps: submission.steps)
				if waiting.isUndo {
					if last?.result == submission.corrects { last = nil }
					notice = waiting.previous == nil
						? "The result is corrected to skipped. A skipped slot counts as no proof."
						: "The earlier outcome is restored by a correction."
					await refresh()
					await showCorrected(execution)
				} else {
					if result > (last?.result ?? 0) {
						last = Saved(execution: execution, result: result, previous: waiting.previous)
					}
					notice = "\(execution.slot.caseRef ?? "Case") · \(submission.outcome.label) recorded on pinned v\(execution.slot.version)."
					if drafts[execution.slot.id]?.note == submission.note { drafts[execution.slot.id]?.note = "" }
					if drafts[execution.slot.id]?.failedStep == submission.failedStep {
						drafts[execution.slot.id]?.failedStep = nil
					}
					let before = reads
					if await read() != .accepted { _ = await read(slotsOnly: true) }
					while acceptedRead <= before {
						let waitingFor = reads
						guard let latestRead else { return true }
						_ = await latestRead.value
						if waitingFor == reads && acceptedRead <= before { return true }
					}
					await advance()
				}
				return true
			}
		} catch {
			notice = "This report's outcome is unknown. Retry checks the same command before another result. " + error.shown
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
		guard !busy, let saved = last else { return }
		if let waiting = pending[saved.execution.slot.id] {
			_ = await send(waiting, recovering: true)
			return
		}
		guard mayRecord(saved.execution) else { return }
		busy = true
		defer { busy = false }
		// Undo must still name the standing result, even if the stream has not refreshed this screen yet.
		guard await read() == .accepted else { return }
		guard let current = last, current.result == saved.result else { return }
		let outcome: ManualOutcome
		if let previous = saved.previous {
			guard case .manual(let prior) = previous.outcome else {
				notice = "This build cannot restore that earlier outcome. Open the run in the web app."
				return
			}
			outcome = prior
		} else { outcome = .skip }
		do {
			let submission = try await project.prepareReport(saved.execution, outcome: outcome,
				note: saved.previous == nil ? "Withdrawn by the author" : (saved.previous?.note ?? ""),
				failedStep: saved.previous?.atStep,
				corrects: saved.result, steps: saved.previous?.steps, restoring: saved.previous?.result)
			let waiting = Pending(submission: submission, previous: saved.previous, isUndo: true)
			pending[saved.execution.slot.id] = waiting
			_ = await deliver(waiting, recovering: false)
		} catch { notice = error.shown }
	}

	private func showCorrected(_ prior: RunExecution) async {
		let slot = latestSlot(prior)
		documents += 1
		let mine = documents
		document = .reading(slot.id)
		draftSlot = slot.id
		do {
			let execution = try await project.execution(of: slot, in: run.ref)
			if mine == documents { document = .read(execution) }
		} catch is CancellationError {
		} catch { if mine == documents { document = .failed(slot, error.shown) } }
	}
}
