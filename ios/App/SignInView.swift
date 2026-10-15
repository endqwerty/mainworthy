import MainworthyScreens
import SwiftUI

struct SignInView: View {
	@Bindable var form: SignInForm
	@FocusState private var focus: Field?

	private enum Field {
		case name, password
	}

	var body: some View {
		NavigationStack {
			Form {
				if let notice = form.notice {
					Section {
						Label(notice, systemImage: "exclamationmark.circle")
							.foregroundStyle(Color.fail)
							.accessibilityIdentifier("sign-in-notice")
					}
				}
				Section {
					// The two content types, with the associated domain the app's entitlements name, are what lets
					// the phone's password AutoFill (and 1Password through it) offer the login it keeps for the site.
					TextField("Name", text: $form.name)
						.textContentType(.username)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
						.focused($focus, equals: .name)
						.submitLabel(.next)
						.onSubmit { focus = .password }
						.accessibilityIdentifier("name")
					SecureField("Password", text: $form.password)
						.textContentType(.password)
						.focused($focus, equals: .password)
						.submitLabel(.go)
						.onSubmit(submit)
						.accessibilityIdentifier("password")
				} footer: {
					Text("Set a password in the web app, under Settings, Your sign-in. A passkey does not work in this build.")
				}
				Section {
					Button(action: submit) {
						HStack {
							Text("Sign in")
							if form.isWorking {
								Spacer()
								ProgressView()
							}
						}
					}
					.disabled(!form.canSubmit)
					.accessibilityIdentifier("sign-in")
				}
				Section {
					Link("Privacy", destination: form.privacyAddress)
						.accessibilityIdentifier("privacy")
				}
			}
			.navigationTitle("Mainworthy")
		}
	}

	private func submit() {
		focus = nil
		Task { await form.submit() }
	}
}
