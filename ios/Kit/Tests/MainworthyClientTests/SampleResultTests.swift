import Foundation
import Testing

@testable import MainworthyClient

struct SampleResultTests {
	@Test("an empty sample has no panel content, including empty fields")
	func emptySample() {
		#expect(!SampleResult(id: 1, detail: nil, note: nil, steps: nil, build: nil, attachments: []).hasContent)
		#expect(!SampleResult(id: 1, detail: "", note: "", steps: [], build: nil, attachments: []).hasContent)
	}

	@Test("each kind of sample evidence makes the panel visible")
	func populatedSample() throws {
		let step = ResultStep(try JSONDecoder().decode(Wire.ResultStep.self, from: Data(#"{"step":"one","outcome":"fail"}"#.utf8)))
		let samples = [
			SampleResult(id: 1, detail: "diagnostic", note: nil, steps: nil, build: nil, attachments: []),
			SampleResult(id: 1, detail: nil, note: "note", steps: nil, build: nil, attachments: []),
			SampleResult(id: 1, detail: nil, note: nil, steps: [step], build: nil, attachments: []),
			SampleResult(id: 1, detail: nil, note: nil, steps: nil, build: URL(string: "https://ci.example/build"), attachments: []),
			SampleResult(id: 1, detail: nil, note: nil, steps: nil, build: nil, attachments: ["log.txt"]),
		]
		#expect(samples.allSatisfy { $0.hasContent })
	}

	@Test("a text file with the server's download type previews literal text")
	func textAttachment() {
		let text = "<script>alert('untrusted')</script>\n**raw**, [link](https://example.com)"
		let file = ResultScreenshot(name: "result.txt", type: "application/octet-stream", data: Data(text.utf8))
		#expect(file.preview == .text(text, truncated: false))
		let html = ResultScreenshot(name: "result.html", type: "application/octet-stream", data: Data(text.utf8))
		#expect(html.preview == .text(text, truncated: false))
	}

	@Test("text previews stop at 64 KiB and indicate that the rest needs sharing")
	func boundedText() {
		let boundary = String(repeating: "a", count: 65_536)
		let exact = ResultScreenshot(name: "result.log", type: "application/octet-stream", data: Data(boundary.utf8))
		#expect(exact.preview == .text(boundary, truncated: false))
		let large = ResultScreenshot(name: "result.txt", type: "application/octet-stream", data: Data((boundary + "rest").utf8))
		#expect(large.preview == .text(boundary, truncated: true))
		let unicode = ResultScreenshot(name: "result.txt", type: "text/plain", data: Data(String(repeating: "é", count: 40_000).utf8))
		#expect(unicode.preview == .text(String(repeating: "é", count: 32_768), truncated: true))
	}

	@Test("image bytes keep their image presentation and other files offer sharing")
	func otherAttachments() {
		#expect(ResultScreenshot(name: "screen.txt", type: "image/png", data: Data()).preview == .image)
		#expect(ResultScreenshot(name: "report.pdf", type: "application/octet-stream", data: Data("%PDF".utf8)).preview == .share)
	}
}
