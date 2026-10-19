import MainworthyClient
import MainworthyScreens
import SwiftUI

/// One rendering for the trail wherever a result appears.
struct ResultTrailView: View {
	let steps: [ResultStep]
	let result: Int
	let attachments: ResultAttachmentScreen

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			if !steps.isEmpty { Text("Step trail").font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
			ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
				VStack(alignment: .leading, spacing: 6) {
					HStack(alignment: .firstTextBaseline, spacing: 8) {
						Text("Step \(step.step)").font(.subheadline.weight(.semibold))
						Spacer(minLength: 0)
						Tag(text: step.outcome.rawValue, tint: outcomeTint(step.outcome.rawValue))
						if let duration = step.durationMs { Text("\(duration) ms").font(.caption.monospacedDigit()) }
					}
					ForEach(Array((step.actions ?? []).enumerated()), id: \.offset) { _, action in
						VStack(alignment: .leading, spacing: 2) {
							Text(action.text).font(.subheadline)
							HStack(spacing: 8) {
								if let outcome = action.outcome {
									Tag(text: outcome.rawValue, tint: outcomeTint(outcome.rawValue))
								}
								if let duration = action.durationMs { Text("\(duration) ms").font(.caption.monospacedDigit()) }
							}
						}
						.padding(.leading, 8)
					}
					if let attachment = step.attachment {
						Button {
							Task { await attachments.open(result: result, index: attachment) }
						} label: {
							Label("Screenshot", systemImage: "photo").font(.subheadline)
						}
						.buttonStyle(.borderless)
						.accessibilityLabel("Screenshot for step \(step.step)")
						.accessibilityIdentifier("trail-screenshot-\(result)-\(index)")
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(10)
				.background(Color.warn.opacity(0.22 * step.heat(in: steps)), in: .rect(cornerRadius: 8))
				.accessibilityIdentifier("trail-step-\(result)-\(index)")
			}
		}
	}
}

extension View {
	func resultAttachments(_ screen: ResultAttachmentScreen) -> some View {
		modifier(ResultAttachmentPresentation(screen: screen))
	}
}

private struct ResultAttachmentPresentation: ViewModifier {
	@Bindable var screen: ResultAttachmentScreen

	func body(content: Content) -> some View {
		content.sheet(isPresented: $screen.presented) {
			NavigationStack {
				Group {
					switch screen.content {
					case .loading: ProgressView("Reading screenshot…")
					case .failed(let why):
						ContentUnavailableView {
							Label("Screenshot could not be read", systemImage: "exclamationmark.triangle")
						} description: { Text(why) } actions: {
							Button("Try again") { Task { await screen.retry() } }
						}
					case .file(let file):
						ScrollView {
							VStack(spacing: 16) {
								Text(file.name).font(.headline).accessibilityIdentifier("screenshot-filename")
								if file.type.hasPrefix("image/"), let image = UIImage(data: file.data) {
									Image(uiImage: image).resizable().scaledToFit()
										.accessibilityLabel(file.name)
										.accessibilityIdentifier("screenshot-image")
								} else {
									Text("This attachment cannot be displayed as an image.").foregroundStyle(.secondary)
								}
							}
							.padding(16)
						}
					}
				}
				.navigationTitle("Screenshot")
				.navigationBarTitleDisplayMode(.inline)
				.toolbar {
					ToolbarItem(placement: .confirmationAction) {
						Button("Done") { screen.presented = false }
					}
				}
			}
			.presentationDragIndicator(.visible)
		}
	}
}
