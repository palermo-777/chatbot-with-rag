const messagesEl = document.getElementById('messages');
const formEl = document.getElementById('query-form');
const inputEl = document.getElementById('question-input');

const tokenGateEl = document.getElementById('token-gate');
const tokenInputEl = document.getElementById('token-input');
const unlockBtn = document.getElementById('unlock-btn');
const uploadAreaEl = document.getElementById('upload-area');
const fileInputEl = document.getElementById('file-input');
const uploadLogEl = document.getElementById('upload-log');
const dbTableEl = document.getElementById('db-rag-table');
const submitBtn = document.getElementById('submit-btn');

formEl.addEventListener('submit', async (e) => {
	e.preventDefault();
	const question = inputEl.value.trim();
	if (!question) return;
	inputEl.value = '';
	addMessage('user', question);

	submitBtn.disabled = true;
	try {
		const response = await fetch('/api/query?' + new URLSearchParams({ text: question }));
		if (!response.ok) {
			addMessage('assistant error', `Request failed (${response.status})`);
			return;
		}
		const { llmAnswer } = await response.json();
		addMessage('assistant', llmAnswer);
	} finally {
		submitBtn.disabled = false;
	}
});

function addMessage(role, text) {
	const el = document.createElement('div');
	el.className = `message ${role}`;
	el.textContent = text;
	messagesEl.appendChild(el);
	messagesEl.scrollTop = messagesEl.scrollHeight;
}

// --- Admin panel ---

async function loadNotes(token) {
	const response = await fetch('/admin/notes', {
		headers: { Authorization: `Bearer ${token}` }
	});

	console.log(response);

	const notes  = await response.json();

	const tbody = dbTableEl.tBodies[0];
	tbody.innerHTML = ''; // clears only the body rows, thead stays intact

	notes.forEach((note) => {

		const newRow = tbody.insertRow(); // insertRow on the tbody itself, not the table — table.insertRow() was landing rows in <thead> instead
		newRow.insertCell().innerHTML = note.id;
		newRow.insertCell().innerHTML = note.text.substring(0,39);

		const actionCell = newRow.insertCell();
		const deleteBtn = document.createElement('button');
		deleteBtn.textContent = 'Delete';
		deleteBtn.addEventListener('click', async () => {
			deleteBtn.disabled = true;
			const deleteResponse = await fetch(`/admin/notes/${note.id}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${token}` },
			});
			if (deleteResponse.ok) {
				newRow.remove();
			} else {
				deleteBtn.disabled = false;
				alert(`Failed to delete note ${note.id}: ${deleteResponse.status}`);
			}
		});
		actionCell.appendChild(deleteBtn);
	});
}

async function unlock(token) {
	sessionStorage.setItem('adminToken', token);

	const response = await fetch('/admin/whoami', {
			headers: { Authorization: `Bearer ${token}` }
	});
	if (response.ok) {
		tokenGateEl.hidden = true;
		uploadAreaEl.hidden = false;


		await loadNotes(token);
	}
	else {
		tokenInputEl.value = '';
		tokenInputEl.placeholder = 'Invalid token — try again';
	}

}

const savedToken = sessionStorage.getItem('adminToken');
if (savedToken) {
	fetch('/admin/whoami', { headers: { Authorization: `Bearer ${savedToken}` } }).then((r) => {
		if (r.ok) unlock(savedToken);
		else sessionStorage.removeItem('adminToken');
	});
}

unlockBtn.addEventListener('click', () => {
	const token = tokenInputEl.value.trim();
	if (token) unlock(token);
});

fileInputEl.addEventListener('change', async () => {
	const token = sessionStorage.getItem('adminToken');
	for (const file of fileInputEl.files) {
		const logLine = document.createElement('div');
		logLine.textContent = `${file.name}: uploading…`;
		uploadLogEl.appendChild(logLine);

		try {
		const response = await fetch('/admin/ingest', {
			method: 'POST',
			headers: { 'Content-Type': 'text/markdown', Authorization: `Bearer ${token}` },
			body: file, // the File object itself — fetch reads and streams its bytes as the body
		});

		if (response.ok) {
			const result = await response.json();
			console.log(result);
			logLine.textContent = `${file.name}: ✓ ${result.message}`;
		} else {
			logLine.textContent = `${file.name}: ✗ ${response.status}:${response.statusText}`;
		}

		}
		catch (error) {
			logLine.textContent += `Error: ${error}`;
		}
	}
	await loadNotes(token);
});
