import SwiftUI

/// What an answer takes beside itself: where a defect is tracked, and the reason the policy asks for.
struct AnswerSheet: View {
	let title: String
	let help: String
	let action: String
	let wantsReference: Bool
	let wantsReason: Bool
	/// What is typed belongs to the screen's class, not to this sheet: the sheet closes before the server
	/// answers, and an answer it refuses must find the text where it was left.
	@Binding var reference: String
	@Binding var reason: String
	let onSubmit: (_ reference: String, _ reason: String) -> Void

	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			Form {
				Section {
					Text(help).foregroundStyle(.secondary)
				}
				if wantsReference {
					Section {
						TextField("SHOP-482, or a link", text: $reference)
							.textInputAutocapitalization(.never)
							.autocorrectionDisabled()
							.accessibilityIdentifier("reference")
					} header: {
						Text("Where it is tracked")
					} footer: {
						Text("Optional.")
					}
				}
				if wantsReason {
					Section {
						TextField("Why", text: $reason, axis: .vertical)
							.lineLimit(3...8)
							.accessibilityIdentifier("reason")
					} header: {
						Text("Reason")
					} footer: {
						Text("The policy of this project asks for one.")
					}
				}
			}
			.navigationTitle(title)
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
				ToolbarItem(placement: .confirmationAction) {
					Button(action) {
						onSubmit(reference, reason)
						dismiss()
					}
					.disabled(wantsReason && reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
					.accessibilityIdentifier("submit-answer")
				}
			}
		}
		.presentationDetents([.medium, .large])
	}
}
