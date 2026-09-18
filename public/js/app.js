/**
 * Knight Bot - Multi-Session Client Application Logic
 */

// Application State
const state = {
    activeTab: 'user',
    currentMethod: 'pair',
    currentSessionId: null,
    eventSource: null,
    adminToken: localStorage.getItem('knight_admin_token') || null,
    allSessions: [],
    statusFilter: 'all',
    searchQuery: '',
    pollInterval: null,
    hasAgreedTerms: false
};

// ==========================================
// INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    checkAdminAuth();
    loadPublicConfig();
});

// Toast Notification Manager
function showToast(message, type = 'success', duration = 3500) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = 'fa-circle-check';
    if (type === 'error') icon = 'fa-circle-exclamation';
    if (type === 'info') icon = 'fa-circle-info';
    
    toast.innerHTML = `<i class="fa-solid ${icon}"></i><span>${message}</span>`;
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(50px)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Tab Switcher
function switchTab(tab) {
    state.activeTab = tab;
    
    document.getElementById('tabBtnUser').classList.toggle('active', tab === 'user');
    document.getElementById('tabBtnAdmin').classList.toggle('active', tab === 'admin');
    
    document.getElementById('userSection').classList.toggle('active', tab === 'user');
    document.getElementById('adminSection').classList.toggle('active', tab === 'admin');
    
    if (tab === 'admin') {
        if (state.adminToken) {
            loadAdminData();
            startAdminPolling();
        }
    } else {
        stopAdminPolling();
    }
}

// Method Selector (Pairing Code vs QR Code)
function selectMethod(method) {
    state.currentMethod = method;
    document.getElementById('btnMethodPair').classList.toggle('active', method === 'pair');
    document.getElementById('btnMethodQr').classList.toggle('active', method === 'qr');
    
    const phoneGroup = document.getElementById('phoneGroup');
    const phoneInput = document.getElementById('phoneNumber');
    const btnText = document.getElementById('btnSubmitText');
    
    if (method === 'pair') {
        phoneGroup.classList.remove('hidden');
        phoneInput.required = true;
        btnText.textContent = 'Generate Pairing Code';
    } else {
        phoneGroup.classList.add('hidden');
        phoneInput.required = false;
        btnText.textContent = 'Generate QR Code';
    }
}

// ==========================================
// USER PORTAL: CONNECTING BOT & PAIRING CODE
// ==========================================
async function handleConnect(e) {
    e.preventDefault();
    
    const btnSubmit = document.getElementById('btnSubmitConnect');
    const btnLoader = document.getElementById('btnLoader');
    const btnText = document.getElementById('btnSubmitText');
    const agreeTerms = document.getElementById('agreeTerms');
    
    if (!state.hasAgreedTerms || !agreeTerms || !agreeTerms.checked) {
        showToast('⚠️ You must open and click "I Agree" in the Terms & Security Protocol before connecting.', 'error');
        openTermsModal();
        return;
    }

    const phoneNumber = document.getElementById('phoneNumber').value.trim();
    const botName = document.getElementById('botName').value.trim();
    const ownerName = document.getElementById('ownerName').value.trim();

    // UI Loading state
    btnSubmit.disabled = true;
    btnLoader.classList.remove('hidden');
    btnText.classList.add('hidden');
    
    // Reset view
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('pairingBox').classList.add('hidden');
    document.getElementById('qrBox').classList.add('hidden');
    document.getElementById('connectedBox').classList.add('hidden');
    
    try {
        let endpoint = '/api/sessions/create-pair';
        let payload = { phoneNumber, botName, ownerName };
        
        if (state.currentMethod === 'qr') {
            endpoint = '/api/sessions/create-qr';
            payload = { botName, ownerName };
        }
        
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = await res.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Failed to initialize session');
        }
        
        state.currentSessionId = data.sessionId;
        showToast('Session started! Waiting for code...', 'info');
        
        // Listen to live Server-Sent Events
        listenToSessionEvents(data.sessionId);
        
    } catch (err) {
        showToast(err.message, 'error');
        document.getElementById('emptyState').classList.remove('hidden');
    } finally {
        btnSubmit.disabled = false;
        btnLoader.classList.add('hidden');
        btnText.classList.remove('hidden');
    }
}

function listenToSessionEvents(sessionId) {
    if (state.eventSource) {
        state.eventSource.close();
    }
    
    state.eventSource = new EventSource(`/api/sessions/${sessionId}/events`);
    
    state.eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            const session = data.session;
            
            if (!session) return;
            
            if (session.status === 'pairing' && session.pairingCode) {
                renderPairingCode(session.pairingCode);
            } else if (session.status === 'scan_qr' && session.qr) {
                renderQrCode(session.qr);
            } else if (session.status === 'online') {
                renderConnectedState(session);
                showToast('🎉 Bot successfully linked and online!', 'success');
                if (state.eventSource) state.eventSource.close();
            } else if (session.status === 'offline') {
                showToast('Session disconnected or closed.', 'info');
            }
        } catch (e) {
            console.error('Error parsing SSE event:', e);
        }
    };
    
    state.eventSource.onerror = () => {
        console.warn('SSE connection closed or lost.');
    };
}

function renderPairingCode(code) {
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('qrBox').classList.add('hidden');
    document.getElementById('connectedBox').classList.add('hidden');
    
    const pairingBox = document.getElementById('pairingBox');
    pairingBox.classList.remove('hidden');
    
    const display = document.getElementById('displayPairingCode');
    display.textContent = code;
    
    showToast(`Pairing Code: ${code}`, 'success');
}

function renderQrCode(qrDataUrl) {
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('pairingBox').classList.add('hidden');
    document.getElementById('connectedBox').classList.add('hidden');
    
    const qrBox = document.getElementById('qrBox');
    qrBox.classList.remove('hidden');
    
    const img = document.getElementById('qrImage');
    img.src = qrDataUrl;
}

function renderConnectedState(session) {
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('pairingBox').classList.add('hidden');
    document.getElementById('qrBox').classList.add('hidden');
    
    const connectedBox = document.getElementById('connectedBox');
    connectedBox.classList.remove('hidden');
    
    document.getElementById('connectedBotName').textContent = session.name || 'Knight Bot';
    document.getElementById('connectedBotNumber').textContent = session.phoneNumber ? `+${session.phoneNumber}` : 'Connected';
    document.getElementById('connectedSessionId').textContent = session.id;
    document.getElementById('connectedUptime').textContent = 'Online Now';
}

function copyPairingCode() {
    const code = document.getElementById('displayPairingCode').textContent.replace(/\s+/g, '').trim();
    if (!code || code === '--------') return;
    
    navigator.clipboard.writeText(code).then(() => {
        const notice = document.getElementById('copyNotice');
        notice.textContent = '✅ Copied to clipboard!';
        notice.style.color = 'var(--primary)';
        showToast('Copied pairing code to clipboard!', 'success');
        setTimeout(() => {
            notice.textContent = 'Tap the code to copy to clipboard';
            notice.style.color = 'var(--text-muted)';
        }, 3000);
    });
}

async function restartCurrentSession() {
    if (!state.currentSessionId) return;
    try {
        await fetch(`/api/sessions/${state.currentSessionId}/restart`, { method: 'POST' });
        showToast('Restart signal sent...', 'info');
    } catch (e) {
        showToast('Failed to restart session', 'error');
    }
}

async function disconnectCurrentSession() {
    if (!state.currentSessionId) return;
    if (!confirm('Are you sure you want to disconnect and delete this bot session?')) return;
    
    try {
        await fetch(`/api/sessions/${state.currentSessionId}/delete`, { method: 'POST' });
        showToast('Bot disconnected.', 'info');
        state.currentSessionId = null;
        document.getElementById('connectedBox').classList.add('hidden');
        document.getElementById('emptyState').classList.remove('hidden');
    } catch (e) {
        showToast('Failed to disconnect session', 'error');
    }
}

// ==========================================
// ADMIN MANAGEMENT HUB
// ==========================================
function checkAdminAuth() {
    if (state.adminToken) {
        document.getElementById('adminLoginCard').classList.add('hidden');
        document.getElementById('adminDashboard').classList.remove('hidden');
    } else {
        document.getElementById('adminLoginCard').classList.remove('hidden');
        document.getElementById('adminDashboard').classList.add('hidden');
    }
}

async function handleAdminLogin(e) {
    e.preventDefault();
    const username = document.getElementById('adminUser').value.trim();
    const password = document.getElementById('adminPass').value.trim();
    const btn = document.getElementById('btnAdminLogin');
    
    btn.disabled = true;
    try {
        const res = await fetch('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await res.json();
        if (!data.success) {
            throw new Error(data.error || 'Authentication failed');
        }
        
        state.adminToken = data.token;
        localStorage.setItem('knight_admin_token', data.token);
        
        showToast('Admin access granted!', 'success');
        checkAdminAuth();
        loadAdminData();
        startAdminPolling();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

function handleAdminLogout() {
    state.adminToken = null;
    localStorage.removeItem('knight_admin_token');
    stopAdminPolling();
    checkAdminAuth();
    showToast('Logged out from Admin Hub.', 'info');
}

async function loadAdminData() {
    if (!state.adminToken) return;
    
    try {
        const headers = { 'Authorization': `Bearer ${state.adminToken}` };
        
        // Fetch Stats
        const statsRes = await fetch('/api/admin/stats', { headers });
        if (statsRes.status === 401) return handleAdminLogout();
        const statsData = await statsRes.json();
        
        if (statsData.success) {
            renderKpis(statsData.stats);
        }
        
        // Fetch Sessions
        const sessRes = await fetch('/api/admin/sessions', { headers });
        const sessData = await sessRes.json();
        if (sessData.success) {
            state.allSessions = sessData.sessions;
            renderSessionsTable(state.allSessions);
        }
        
        // Fetch Logs
        const logsRes = await fetch('/api/admin/logs', { headers });
        const logsData = await logsRes.json();
        if (logsData.success) {
            renderLogs(logsData.logs);
        }
    } catch (e) {
        console.error('Error loading admin data:', e);
    }
}

function renderKpis(stats) {
    document.getElementById('kpiActiveBots').textContent = stats.activeOnline || 0;
    document.getElementById('kpiTotalBots').textContent = `${stats.totalSessions || 0} Total Registered`;
    document.getElementById('kpiTotalMessages').textContent = Number(stats.totalMessages || 0).toLocaleString();
    document.getElementById('kpiRamUsage').textContent = `${stats.memory?.rssMB || 0} MB`;
    document.getElementById('kpiHeapUsage').textContent = `Heap: ${stats.memory?.heapUsedMB || 0} MB`;
    
    const hrs = Math.floor((stats.uptimeSeconds || 0) / 3600);
    const mins = Math.floor(((stats.uptimeSeconds || 0) % 3600) / 60);
    document.getElementById('kpiUptime').textContent = `${hrs}h ${mins}m`;
}

function renderSessionsTable(sessions) {
    const tbody = document.getElementById('sessionTableBody');
    
    let filtered = sessions;
    if (state.statusFilter !== 'all') {
        filtered = filtered.filter(s => s.status === state.statusFilter);
    }
    if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        filtered = filtered.filter(s => 
            (s.id && s.id.toLowerCase().includes(q)) ||
            (s.phoneNumber && s.phoneNumber.toLowerCase().includes(q)) ||
            (s.name && s.name.toLowerCase().includes(q)) ||
            (s.ownerName && s.ownerName.toLowerCase().includes(q))
        );
    }
    
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="loading-cell">No bot sessions found.</td></tr>`;
        return;
    }
    
    tbody.innerHTML = filtered.map(s => {
        let statusBadgeClass = 'offline';
        if (s.status === 'online') statusBadgeClass = 'online';
        if (s.status === 'pairing' || s.status === 'scan_qr') statusBadgeClass = 'pairing';
        if (s.status === 'error') statusBadgeClass = 'error';
        
        const isPaused = Boolean(s.isPaused);
        
        return `
            <tr>
                <td><span class="session-id-tag">${s.id}</span></td>
                <td><strong>${s.phoneNumber ? '+' + s.phoneNumber : 'N/A'}</strong></td>
                <td>${s.name || 'Knight Bot'}</td>
                <td><span class="status-badge ${statusBadgeClass}"><i class="fa-solid fa-circle fa-2xs"></i> ${s.status}</span></td>
                <td>
                    <button class="btn-tbl-action ${isPaused ? 'danger' : ''}" onclick="adminTogglePause('${s.id}')" title="${isPaused ? 'Resume Bot Processing' : 'Pause Bot Processing'}">
                        <i class="fa-solid ${isPaused ? 'fa-play' : 'fa-pause'}"></i>
                    </button>
                </td>
                <td><code>${s.pairingCode || '—'}</code></td>
                <td><small>${new Date(s.lastActive || s.createdAt).toLocaleTimeString()}</small></td>
                <td>
                    <div class="action-btn-group">
                        <button class="btn-tbl-action" onclick="openConfigModal('${s.id}')" title="Edit Bot Settings"><i class="fa-solid fa-sliders"></i></button>
                        <button class="btn-tbl-action" onclick="adminRestartSession('${s.id}')" title="Restart Bot"><i class="fa-solid fa-rotate"></i></button>
                        <button class="btn-tbl-action danger" onclick="adminDeleteSession('${s.id}')" title="Delete Session"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function renderLogs(logs) {
    const container = document.getElementById('terminalLogs');
    if (!logs || logs.length === 0) return;
    
    container.innerHTML = logs.map(l => {
        let cls = 'log-info';
        if (l.type === 'success') cls = 'log-success';
        if (l.type === 'warn') cls = 'log-warn';
        if (l.type === 'error') cls = 'log-error';
        const time = new Date(l.timestamp).toLocaleTimeString();
        return `<div class="log-entry ${cls}">[${time}] ${l.message}</div>`;
    }).join('');
}

function filterByStatus(status, btn) {
    state.statusFilter = status;
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    renderSessionsTable(state.allSessions);
}

function filterSessionsTable() {
    state.searchQuery = document.getElementById('searchSessionInput').value.trim();
    renderSessionsTable(state.allSessions);
}

function refreshAdminSessions() {
    loadAdminData();
    showToast('Refreshed session registry', 'info');
}

async function adminRestartSession(sessionId) {
    try {
        const res = await fetch(`/api/sessions/${sessionId}/restart`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${state.adminToken}` }
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Restarting session ${sessionId}...`, 'info');
            setTimeout(loadAdminData, 2000);
        }
    } catch (e) {
        showToast('Error restarting session', 'error');
    }
}

async function adminDeleteSession(sessionId) {
    if (!confirm(`Are you sure you want to completely delete session "${sessionId}"?`)) return;
    
    try {
        const res = await fetch(`/api/sessions/${sessionId}/delete`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${state.adminToken}` }
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Session ${sessionId} deleted permanently.`, 'success');
            loadAdminData();
        }
    } catch (e) {
        showToast('Error deleting session', 'error');
    }
}

async function adminTogglePause(sessionId) {
    try {
        const res = await fetch(`/api/admin/sessions/${sessionId}/pause`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${state.adminToken}` }
        });
        const data = await res.json();
        if (data.success) {
            showToast(data.message, 'info');
            loadAdminData();
        }
    } catch (e) {
        showToast('Error toggling pause state', 'error');
    }
}

// Bot Configuration Editor Modal
function openConfigModal(sessionId) {
    const session = state.allSessions.find(s => s.id === sessionId);
    if (!session) return;
    
    document.getElementById('editSessionId').value = sessionId;
    document.getElementById('editBotName').value = session.name || '';
    document.getElementById('editOwnerName').value = session.ownerName || '';
    document.getElementById('editOwnerNumber').value = session.ownerNumber || session.phoneNumber || '';
    document.getElementById('editAutoRestart').checked = session.autoRestart !== false;
    
    document.getElementById('configModal').classList.remove('hidden');
}

function closeConfigModal() {
    document.getElementById('configModal').classList.add('hidden');
}

async function handleSaveConfig() {
    const sessionId = document.getElementById('editSessionId').value;
    const botName = document.getElementById('editBotName').value.trim();
    const ownerName = document.getElementById('editOwnerName').value.trim();
    const ownerNumber = document.getElementById('editOwnerNumber').value.trim();
    const autoRestart = document.getElementById('editAutoRestart').checked;
    
    try {
        const res = await fetch(`/api/admin/sessions/${sessionId}/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.adminToken}`
            },
            body: JSON.stringify({ botName, ownerName, ownerNumber, autoRestart })
        });
        
        const data = await res.json();
        if (data.success) {
            showToast('Settings saved successfully!', 'success');
            closeConfigModal();
            loadAdminData();
        } else {
            showToast(data.error || 'Failed to update settings', 'error');
        }
    } catch (e) {
        showToast('Error saving settings', 'error');
    }
}

// Direct Message Modal
function openDirectMessageModal() {
    const select = document.getElementById('dmSenderSession');
    const onlineBots = state.allSessions.filter(s => s.status === 'online');
    
    if (onlineBots.length === 0) {
        return showToast('No online bots available to send message', 'error');
    }
    
    select.innerHTML = onlineBots.map(b => `<option value="${b.id}">${b.name} (+${b.phoneNumber})</option>`).join('');
    document.getElementById('dmTargetNumber').value = '';
    document.getElementById('dmMessageText').value = '';
    document.getElementById('directMessageModal').classList.remove('hidden');
}

function closeDirectMessageModal() {
    document.getElementById('directMessageModal').classList.add('hidden');
}

async function handleSendDirectMessage() {
    const sessionId = document.getElementById('dmSenderSession').value;
    const targetJid = document.getElementById('dmTargetNumber').value.trim();
    const message = document.getElementById('dmMessageText').value.trim();
    
    if (!targetJid || !message) {
        return showToast('Target phone and message text are required', 'error');
    }
    
    try {
        const res = await fetch('/api/admin/send-message', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.adminToken}`
            },
            body: JSON.stringify({ sessionId, targetJid, message })
        });
        
        const data = await res.json();
        if (data.success) {
            showToast('Direct WhatsApp message sent successfully!', 'success');
            closeDirectMessageModal();
        } else {
            showToast(data.error || 'Failed to send message', 'error');
        }
    } catch (e) {
        showToast('Error sending message', 'error');
    }
}

// System Cleanup Action
async function handleCleanSystem() {
    if (!confirm('Clean temporary media cache and remove orphan session files?')) return;
    
    try {
        const res = await fetch('/api/admin/cleanup', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${state.adminToken}` }
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Cleanup finished! Removed ${data.result?.cleanedFolders || 0} dead folders.`, 'success');
            loadAdminData();
        }
    } catch (e) {
        showToast('Error cleaning system', 'error');
    }
}

// Export Backup Action
function handleExportBackup() {
    window.open('/api/admin/export', '_blank');
}

// Global Broadcast Modal
function openBroadcastModal() {
    document.getElementById('broadcastModal').classList.remove('hidden');
}

function closeBroadcastModal() {
    document.getElementById('broadcastModal').classList.add('hidden');
    document.getElementById('broadcastMessage').value = '';
}

async function sendBroadcast() {
    const message = document.getElementById('broadcastMessage').value.trim();
    if (!message) {
        return showToast('Please enter a message to broadcast', 'error');
    }
    
    try {
        const res = await fetch('/api/admin/broadcast', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.adminToken}`
            },
            body: JSON.stringify({ message })
        });
        
        const data = await res.json();
        if (data.success) {
            showToast(`Broadcast sent to ${data.result?.sentCount || 0} active bots!`, 'success');
            closeBroadcastModal();
        } else {
            showToast(data.error || 'Broadcast failed', 'error');
        }
    } catch (e) {
        showToast('Failed to send broadcast', 'error');
    }
}

// Polling for Admin Hub
function startAdminPolling() {
    stopAdminPolling();
    state.pollInterval = setInterval(loadAdminData, 4000);
}

function stopAdminPolling() {
    if (state.pollInterval) {
        clearInterval(state.pollInterval);
        state.pollInterval = null;
    }
}

// ==========================================
// PUBLIC CONFIG & SUPPORT DESK LOADER
// ==========================================
async function loadPublicConfig() {
    try {
        const res = await fetch('/api/config/public');
        const data = await res.json();
        if (data.success) {
            // Update WhatsApp Support
            if (data.supportWhatsApp) {
                const waNumber = data.supportWhatsApp.replace(/[^0-9]/g, '');
                const waBox = document.getElementById('suppWaBox');
                const waText = document.getElementById('suppWaText');
                if (waBox) waBox.href = `https://wa.me/${waNumber}`;
                if (waText) waText.textContent = `+${waNumber}`;
            }
            // Update Email Desk
            if (data.supportEmail) {
                const emailBox = document.getElementById('suppEmailBox');
                const emailText = document.getElementById('suppEmailText');
                if (emailBox) emailBox.href = `mailto:${data.supportEmail}`;
                if (emailText) emailText.textContent = data.supportEmail;
            }
            // Update Telegram Channel
            if (data.supportTelegram) {
                const tgBox = document.getElementById('suppTgBox');
                if (tgBox) tgBox.href = data.supportTelegram;
            }
            // Update Official Channel
            if (data.supportChannel) {
                const channelBox = document.getElementById('suppChannelBox');
                if (channelBox) channelBox.href = data.supportChannel;
            }
        }
    } catch (e) {
        console.warn('Failed to load public config:', e);
    }
}

// ==========================================
// TERMS OF SERVICE & SECURITY MODAL HANDLERS
// ==========================================
function triggerTermsModal(e) {
    if (e.target.closest('#btnReviewTerms')) return;
    openTermsModal();
}

function openTermsModal(e) {
    if (e) e.stopPropagation();
    const modal = document.getElementById('termsModal');
    if (modal) modal.classList.remove('hidden');
}

function closeTermsModal() {
    const modal = document.getElementById('termsModal');
    if (modal) modal.classList.add('hidden');
}

function acceptTermsAndClose() {
    state.hasAgreedTerms = true;
    const checkbox = document.getElementById('agreeTerms');
    if (checkbox) {
        checkbox.disabled = false;
        checkbox.checked = true;
    }
    
    updateTermsUI(true);
    closeTermsModal();
    showToast('🎉 Terms & Privacy Protocol accepted! Connection unlocked.', 'success');
}

function updateTermsUI(isAgreed) {
    const badge = document.getElementById('termsBadge');
    const card = document.getElementById('termsCardBox');
    const mainLabel = document.getElementById('termsMainLabel');
    const subLabel = document.getElementById('termsSubLabel');
    const btnReview = document.getElementById('btnReviewTerms');
    
    if (isAgreed) {
        if (card) card.classList.add('verified');
        if (badge) {
            badge.className = 'terms-pill pill-verified';
            badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> <span>Agreed</span>';
        }
        if (mainLabel) mainLabel.textContent = 'Terms of Service, Privacy & Security Protocols Accepted';
        if (subLabel) subLabel.textContent = '✅ You are verified & cleared to connect';
        if (btnReview) {
            btnReview.innerHTML = '<i class="fa-solid fa-eye"></i> View Terms';
        }
    } else {
        if (card) card.classList.remove('verified');
        if (badge) {
            badge.className = 'terms-pill pill-locked';
            badge.innerHTML = '<i class="fa-solid fa-lock"></i> <span>Locked</span>';
        }
        if (mainLabel) mainLabel.textContent = 'I agree to Terms of Service, Privacy & Security Protocols';
        if (subLabel) subLabel.textContent = 'Click to open & accept in modal to tick this box';
        if (btnReview) {
            btnReview.innerHTML = '<i class="fa-solid fa-arrow-up-right-from-square"></i> Review Terms';
        }
    }
}

// ==========================================
// FAQ ACCORDION HANDLER
// ==========================================
function toggleFaq(item) {
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item').forEach(el => el.classList.remove('open'));
    if (!isOpen) {
        item.classList.add('open');
    }
}
