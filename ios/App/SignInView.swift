import MainworthyScreens
import SwiftUI

struct SignInView: View {
	@Bindable var form: SignInForm
	@FocusState private var focus: Field?

	private enum Field {
		case address, name, password, token
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
					TextField("mainworthy.example", text: $form.address)
						.keyboardType(.URL)
						.textContentType(.URL)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
						.focused($focus, equals: .address)
						.submitLabel(.next)
						.onSubmit { focus = form.way == .password ? .name : .token }
						.accessibilityIdentifier("address")
				} header: {
					Text("Instance")
				} footer: {
					Text("The address you open Mainworthy at in a browser.")
				}
				Section {
					Picker("Sign in with", selection: $form.way) {
						Text("Password").tag(SignInForm.Way.password)
						Text("Token").tag(SignInForm.Way.token)
					}
					.pickerStyle(.segmented)
					switch form.way {
					case .password:
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
					case .token:
						SecureField("Token", text: $form.token)
							.focused($focus, equals: .token)
							.submitLabel(.go)
							.onSubmit(submit)
							.accessibilityIdentifier("token")
					}
				} footer: {
					Text(
						form.way == .password
							? "Set a password in the web app, under Settings, Your sign-in. A passkey does not work in this build."
							: "A token opens a session, like in the web app. The app keeps the session and not the token."
					)
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
			}
			.navigationTitle("Mainworthy")
		}
	}

	private func submit() {
		focus = nil
		Task { await form.submit() }
	}
}
