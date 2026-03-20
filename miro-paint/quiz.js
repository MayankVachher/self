/* ========================================
   ATELIER QUIZ — Logic
   ======================================== */

const state = {
    currentScreen: 'intro',
    currentQuestion: 0,
    answers: {},
    totalQuestions: 5,
    userName: '',
    userEmail: ''
};

const screens = [
    'intro',
    'q1', 'q2', 'q3', 'q4', 'q5',
    'email'
    // result screens are dynamic
];

// --- Navigation ---

function showScreen(screenName) {
    // Hide all screens
    document.querySelectorAll('.quiz-screen').forEach(s => {
        s.classList.remove('active', 'slide-in-right', 'slide-in-left');
    });

    // Show target screen
    const target = document.querySelector(`[data-screen="${screenName}"]`);
    if (target) {
        target.classList.add('active', 'slide-in-right');
    }

    state.currentScreen = screenName;

    // Update progress
    updateProgress();

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateProgress() {
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');

    if (state.currentScreen === 'intro') {
        progressFill.style.width = '0%';
        progressText.textContent = '';
        return;
    }

    if (state.currentScreen === 'email' || state.currentScreen.startsWith('result')) {
        progressFill.style.width = '100%';
        progressText.textContent = state.currentScreen === 'email' ? 'Almost there!' : 'Complete!';
        return;
    }

    const qNum = parseInt(state.currentScreen.replace('q', ''));
    const pct = (qNum / state.totalQuestions) * 100;
    progressFill.style.width = pct + '%';
    progressText.textContent = `Question ${qNum} of ${state.totalQuestions}`;
}

// --- Quiz Flow ---

function startQuiz() {
    state.currentQuestion = 1;
    showScreen('q1');
}

function selectChoice(el) {
    const screen = el.closest('.quiz-screen');
    const questionKey = screen.dataset.screen;
    const value = el.dataset.value;

    // Deselect siblings
    screen.querySelectorAll('.choice').forEach(c => c.classList.remove('selected'));

    // Select this one
    el.classList.add('selected');

    // Store answer
    state.answers[questionKey] = value;

    // Auto-advance after a short delay
    setTimeout(() => {
        const qNum = parseInt(questionKey.replace('q', ''));
        if (qNum < state.totalQuestions) {
            state.currentQuestion = qNum + 1;
            showScreen('q' + (qNum + 1));
        } else {
            // Last question — go to email gate
            showScreen('email');
        }
    }, 600);
}

// --- Email & Results ---

function submitEmail(e) {
    e.preventDefault();

    state.userName = document.getElementById('userName').value;
    state.userEmail = document.getElementById('userEmail').value;

    // Calculate result
    const result = calculateResult();

    // Show result screen
    showScreen('result-' + result);

    // Personalize the result
    personalizeResult(result);

    // In production: send data to your CRM/email service here
    console.log('Lead captured:', {
        name: state.userName,
        email: state.userEmail,
        style: result,
        answers: state.answers
    });
}

function calculateResult() {
    const tally = {
        dramatic: 0,
        impressionist: 0,
        modern: 0,
        classical: 0
    };

    Object.values(state.answers).forEach(val => {
        if (tally.hasOwnProperty(val)) {
            tally[val]++;
        }
    });

    // Find the winner
    let maxVal = 0;
    let winner = 'impressionist'; // default

    for (const [style, count] of Object.entries(tally)) {
        if (count > maxVal) {
            maxVal = count;
            winner = style;
        }
    }

    return winner;
}

function personalizeResult(result) {
    const screen = document.querySelector(`[data-screen="result-${result}"]`);
    if (!screen) return;

    // Add user's name if we want to personalize
    // Could inject "Sarah, you're a..." etc.
}

// --- Share ---

function shareResult(platform) {
    const resultType = state.currentScreen.replace('result-', '');
    const styleNames = {
        dramatic: 'Dramatic Realist',
        impressionist: 'Luminous Impressionist',
        modern: 'Bold Abstractionist',
        classical: 'Classical Naturalist'
    };
    const styleName = styleNames[resultType] || 'artist';

    if (platform === 'copy') {
        const url = window.location.origin + window.location.pathname + '?result=' + resultType;
        navigator.clipboard.writeText(`I'm a ${styleName}! 🎨 Take the Atelier painting style quiz: ${url}`).then(() => {
            const btn = event.target;
            btn.textContent = 'Copied! ✓';
            setTimeout(() => { btn.textContent = 'Copy Link'; }, 2000);
        });
    } else if (platform === 'instagram') {
        // In production: generate a shareable story image
        alert(`Share tip: Screenshot your result and post it to your Instagram Story! Tag @atelier to get featured.`);
    }
}

// --- Keyboard Navigation ---

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        window.location.href = 'index.html';
    }
});

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
    showScreen('intro');
});
