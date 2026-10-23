import Foundation
import MainworthyClient
import Observation

/// The attachment a person chose in a result. It loads only after the choice.
@MainActor @Observable
public final class ResultAttachmentScreen {
	public enum Content: Equatable {
		case loading
		case file(ResultScreenshot)
		case failed(String)
	}

	public var presented = false
	public private(set) var content = Content.loading
	private let project: ProjectClient
	private var reads = 0
	private var selected: (result: Int, index: Int)?

	package init(project: ProjectClient) { self.project = project }

	public func open(result: Int, index: Int) async {
		selected = (result, index)
		presented = true
		reads += 1
		let mine = reads
		content = .loading
		do {
			let screenshot = try await project.screenshot(result: result, index: index)
			guard mine == reads, presented else { return }
			content = .file(screenshot)
		} catch {
			guard mine == reads, presented else { return }
			content = .failed(error.shown)
		}
	}

	public func retry() async {
		guard let selected else { return }
		await open(result: selected.result, index: selected.index)
	}
}
