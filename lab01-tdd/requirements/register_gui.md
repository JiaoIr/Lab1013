# Registration Page

Create an accessible registration page where someone can enter a username, email address, optional date of birth, password, and password confirmation, accept the terms of service, and submit the form.

Validate the information using sensible conventions for a modern registration service. Help the user understand and correct invalid input. Prevent duplicate registrations across page reloads without saving passwords.

After successful registration, keep every entered value and the terms selection in place; do not automatically reset or clear the form. Include one initially empty `<p role="status"></p>`. On success, display exactly `Account created.` in that element and keep it visible until the next submission. Clear it at the start of each submission so a rejected attempt cannot retain an old success message.

Let users reveal the password values while typing and hide them again. Use a trustworthy public-service visual style: a full-width dark navy-blue service header with a restrained orange accent, a pale blue-gray page background, and a centered white registration panel with an orange primary submit action. On typical desktop screens, place related fields in two columns where space permits; collapse them to one column on narrow mobile screens without horizontal scrolling. Keep the page clear, keyboard accessible, responsive, and comfortable to use.
