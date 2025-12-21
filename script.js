/**
 * The HR app
 * Core Logic - Handles State, Geolocation, and UI Updates.
 */

// Global Error Handler (Must be first)
window.onerror = function (msg, url, line, col, error) {
    alert("⚠️ CRITICAL ERROR:\n" + msg + "\nLine: " + line);
    return false;
};

class HRApp {
    constructor() {
        // Initialize Default DB structure if new or empty
        const defaultDB = {
            companies: {
                // Default Demo Company for easy testing
                "DEMO": {
                    sites: [
                        { id: 'site_1', name: "Main HQ", lat: 31.9686, lng: 99.9018 } // Placeholder
                    ],
                    employees: [],
                    logs: []
                }
            },
            users: {
                "manager": { role: 'manager', companyId: 'DEMO', password: '123' },
                // Employees will be added here dynamically
            }
        };

        this.mockDB = JSON.parse(localStorage.getItem('hrapp_db')) || defaultDB;

        this.currentUser = null;
        this.currentPosition = null;
        this.watchId = null;

        // Constants
        this.MAX_DISTANCE_METERS = 100; // Geofence radius

        // Wrap init in try-catch just in case
        try {
            this.init();
        } catch (e) {
            alert("Init Error: " + e.message);
        }
    }

    init() {
        this.migrateData(); // Fix legacy data

        // Start GPS immediately (for Login Screen status)
        this.watchLocation();

        // Restore session if exists
        const storedUser = localStorage.getItem('hrapp_user');
        if (storedUser) {
            this.currentUser = JSON.parse(storedUser);
            // Verify user still exists in DB
            if (this.mockDB.users[this.currentUser.username]) {
                this.showView(this.currentUser.role === 'manager' ? 'view-manager' : 'view-employee');
                this.refreshDashboard();
            } else {
                this.logout(); // Invalid session
            }
        } else {
            this.showView('view-auth'); // Default to Auth
        }
    }

    migrateData() {
        // 1. Lowercase Usernames
        let changed = false;
        const newUsers = {};
        Object.keys(this.mockDB.users).forEach(key => {
            const lowerKey = key.toLowerCase();
            if (key !== lowerKey) {
                // Move data to lowercase key
                newUsers[lowerKey] = this.mockDB.users[key];
                changed = true;
            } else {
                newUsers[key] = this.mockDB.users[key];
            }
            // Ensure verify flag exists (Migration for older users)
            if (typeof newUsers[lowerKey].verified === 'undefined') {
                newUsers[lowerKey].verified = true; // Legacy users auto-verify
                changed = true;
            }
        });
        this.mockDB.users = newUsers;

        if (changed) {
            console.log("Database Migrated: Usernames normalized & Legacy users verified.");
            this.saveDB();
        }
    }

    saveDB() {
        localStorage.setItem('hrapp_db', JSON.stringify(this.mockDB));
    }

    setupLocationWatcher() {
        // Deprecated helper, but kept for safety if legacy calls exist
        this.watchLocation();
    }

    // --- Authentication ---

    registerNewCompany() {
        const companyName = document.getElementById('reg-company-name').value.trim();
        const managerName = document.getElementById('reg-manager-name').value.trim().toLowerCase();

        if (!companyName || !managerName) return alert("Please fill all fields");
        if (this.mockDB.users[managerName]) return alert("Username already taken! Choose another manager username.");

        // Generate ID
        const companyId = (companyName.substring(0, 4) + Math.floor(1000 + Math.random() * 9000)).toUpperCase();

        // 1. Create Company
        this.mockDB.companies[companyId] = {
            name: companyName,
            sites: [],
            employees: [],
            logs: []
        };

        // 2. Create Manager - UNVERIFIED INITIALLY
        this.mockDB.users[managerName] = {
            role: 'manager',
            companyId: companyId,
            verified: false // Email Verification Required
        };

        this.saveDB();

        alert(`🎉 Company Created. Please Login to Verify your Email.`);
        document.getElementById('auth-username').value = managerName;
        document.getElementById('auth-company').value = companyId;
        this.showView('view-auth');
    }

    registerNewEmployeeUser() {
        const username = document.getElementById('reg-emp-username-self').value.trim().toLowerCase();
        const email = document.getElementById('reg-emp-email-self').value.trim();

        if (!username || !email) return alert("Please fill all fields");
        if (this.mockDB.users[username]) return alert("Username already taken!");

        // Create Unassigned User
        this.mockDB.users[username] = {
            role: 'employee',
            companyId: null,
            email: email,
            assignedSiteId: null,
            status: 'checked-out',
            verified: false // Email Verification Required
        };

        this.saveDB();
        alert(`🎉 Account Created! Please Login to Verify your Email.`);
        this.showView('view-auth');
    }

    // --- VERIFICATION ---
    verifyEmail() {
        const code = document.getElementById('verify-code').value.trim();
        if (code !== "1234") {
            return alert("❌ Invalid Code. Please try again.");
        }

        // Success
        if (this.pendingUser) {
            const user = this.mockDB.users[this.pendingUser.username];
            user.verified = true;
            this.saveDB();

            alert("✅ Email Verified Successfully!");

            // Proceed to Login
            this.currentUser = { username: this.pendingUser.username, ...user };
            localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));
            this.pendingUser = null;

            if (!this.mockDB.companies[user.companyId] && user.role === 'manager') {
                this.mockDB.companies[user.companyId] = { sites: [], employees: [], logs: [] };
                this.saveDB();
            }

            this.showView(user.role === 'manager' ? 'view-manager' : 'view-employee');
            this.refreshDashboard();
        }
    }

    login() {
        const usernameInput = document.getElementById('auth-username');
        const companyInput = document.getElementById('auth-company');

        const username = usernameInput.value.trim().toLowerCase();
        let companyId = companyInput.value.trim().toUpperCase();

        if (!username) return alert("Please enter your Username");

        // --- AUTO-DETECT COMPANY ID LOGIC ---
        const user = this.mockDB.users[username];
        if (!user) return alert("User not found! Please Register first.");

        if (!companyId) {
            // Try to find it from user record
            if (user.companyId) {
                companyId = user.companyId;
                companyInput.value = companyId; // Auto-fill UI
                alert(`ℹ️ Found Company ID: ${companyId}\nProcessing Login...`);
            } else {
                return alert("Welcome! You do not have a Company ID yet.\nPlease ask your Manager to link your account.");
            }
        }

        // --- STANDARD CHECKS ---
        if (user.companyId && user.companyId !== companyId) {
            return alert(`❌ Incorrect Company ID.\nThis user belongs to company: ${user.companyId}`);
        }

        // --- EMAIL VERIFICATION CHECK ---
        if (user.verified === false) {
            this.pendingUser = { username, ...user };
            this.showView('view-verify');
            return;
        }

        // Case: User exists but not assigned to a company yet
        if (!user.companyId) {
            return alert(`Welcome, ${username}!\n\nYou are not linked to a company yet.\nAsk your Manager to 'Register' you using username: "${username}".`);
        }

        // --- STRICT LOCATION CHECK (Employees Only) ---
        if (user.role === 'employee') {
            // 1. Check if GPS is ready
            if (!this.currentPosition) {
                alert("📍 DETECTING LOCATION...\n\nPlease allow GPS access and wait a moment.\nWe are fetching your precise location now.");

                // Force a high-accuracy read
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        this.currentPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                        this.updateUIWithLocation();
                        alert("✅ GPS Linked! Click 'Login' again.");
                    },
                    (err) => {
                        alert("❌ GPS Error: " + err.message + "\nEnsure Location Services are ON.");
                        this.updateUIWithLocation(true, err.message); // Update UI with error
                    },
                    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
                );
                return; // Stop login until GPS is ready
            }

            // 2. Check Distance to Assigned Site
            const company = this.mockDB.companies[user.companyId];
            const site = company.sites.find(s => s.id === user.assignedSiteId);

            if (!site) return alert("Error: Assigned Worksite not found. Contact Manager.");

            const dist = this.getDistanceFromLatLonInMiters(
                this.currentPosition.lat, this.currentPosition.lng,
                site.lat, site.lng
            );

            if (dist > this.MAX_DISTANCE_METERS) {
                return alert(`🚫 ACCESS DENIED\n\nYou are ${Math.round(dist)} meters away from ${site.name}.\n\nYou must be within ${this.MAX_DISTANCE_METERS}m to log in.`);
            }
        }
        // ---------------------------------------------

        // Login Success
        this.currentUser = { username, ...user };
        localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));

        this.showView(user.role === 'manager' ? 'view-manager' : 'view-employee');
        this.refreshDashboard();
    }

    logout() {
        // Auto-checkout if employee is currently checked in
        if (this.currentUser && this.currentUser.role === 'employee') {
            const user = this.mockDB.users[this.currentUser.username];
            if (user && user.status === 'checked-in') {
                this.checkOut("Auto Check-Out (Logout)");
            }
        }

        this.currentUser = null;
        localStorage.removeItem('hrapp_user');
        this.showView('view-auth');
        // Stop timer
        if (this.timerInterval) clearInterval(this.timerInterval);
    }

    // --- Geolocation ---

    watchLocation() {
        if (!navigator.geolocation) {
            alert("Geolocation is not supported by your browser");
            return;
        }

        // Update UI to show we are trying
        const statusEl = document.getElementById('auth-gps-status');
        if (statusEl) statusEl.innerHTML = `<span>🔄 Acquiring Signal...</span>`;

        this.watchId = navigator.geolocation.watchPosition(
            (position) => {
                this.currentPosition = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };
                this.updateUIWithLocation(); // Updates all views

                // Monitor Geofence if Logged In as Employee
                if (this.currentUser && this.currentUser.role === 'employee') {
                    this.monitorGeofence();
                }
            },
            (error) => {
                console.error("Error watching position:", error);

                let msg = "GPS Error";
                if (error.code === 1) msg = "⚠️ Location Denied.";
                if (error.code === 2) msg = "⚠️ Unavailable.";
                if (error.code === 3) msg = "⚠️ Timeout.";

                // Update Login UI Status - SOFT WARNING
                if (statusEl) {
                    statusEl.innerHTML = `<span style="color:var(--accent-gray);">${msg} (Manager Login OK)</span> <button onclick="app.watchLocation()" style="background:none; border:1px solid currentColor; color:inherit; padding:2px 6px; font-size:0.7rem; cursor:pointer; border-radius:4px;">RETRY</button>`;
                }
            },
            {
                enableHighAccuracy: true,
                maximumAge: 0,
                timeout: 10000
            }
        );
    }

    monitorGeofence() {
        const user = this.mockDB.users[this.currentUser.username];
        if (user.status !== 'checked-in') return;

        const company = this.mockDB.companies[this.currentUser.companyId];
        const site = company.sites.find(s => s.id === user.assignedSiteId);
        if (!site) return;

        const dist = this.getDistanceFromLatLonInMiters(
            this.currentPosition.lat, this.currentPosition.lng,
            site.lat, site.lng
        );

        // Auto Checkout if outside geofence
        if (dist > this.MAX_DISTANCE_METERS + 20) { // +20m buffer
            // Logic to warn or checkout
            // For strict rule: Auto Checkout
            this.checkOut('Auto Check-Out (Geofence)');
            alert(`You left the worksite boundary (${Math.round(dist)}m).\nChecked out automatically.`);
        }
    }

    // Helper
    getDistanceFromLatLonInMiters(lat1, lon1, lat2, lon2) {
        var R = 6371; // Radius of the earth in km
        var dLat = this.deg2rad(lat2 - lat1);
        var dLon = this.deg2rad(lon2 - lon1);
        var a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this.deg2rad(lat1)) * Math.cos(this.deg2rad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        var d = R * c; // Distance in km
        return d * 1000; // in meters
    }

    deg2rad(deg) {
        return deg * (Math.PI / 180)
    }

    // --- View Management ---

    showView(viewId) {
        document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
        document.getElementById(viewId).classList.add('active');
    }

    updateUIWithLocation() {
        if (!this.currentPosition) return;

        const text = `${this.currentPosition.lat.toFixed(6)}, ${this.currentPosition.lng.toFixed(6)}`;

        // Update Dashboard coords
        if (document.getElementById('manager-coords'))
            document.getElementById('manager-coords').innerText = text;
        if (document.getElementById('emp-coords'))
            document.getElementById('emp-coords').innerText = text;

        // Update Login Screen Status
        const statusEl = document.getElementById('auth-gps-status');
        if (statusEl) {
            statusEl.innerHTML = `<span style="color:#28a745;">✅ GPS Active</span> <span style="font-family:monospace; margin-left:8px;">${this.currentPosition.lat.toFixed(4)}...</span>`;
            statusEl.style.background = "rgba(40, 167, 69, 0.1)"; // Green tint
            statusEl.style.color = "#28a745";
        }
    }

    // --- Manager Features ---

    createSite() {
        const siteName = document.getElementById('new-site-name').value.trim();
        if (!siteName) return alert("Enter a Site Name");
        if (!this.currentPosition) return alert("Waiting for GPS signal...");

        const company = this.mockDB.companies[this.currentUser.companyId];

        const newSite = {
            id: 'site_' + Date.now(),
            name: siteName,
            lat: this.currentPosition.lat,
            lng: this.currentPosition.lng
        };

        if (!company.sites) company.sites = [];
        company.sites.push(newSite);
        this.saveDB();

        alert(`Site "${siteName}" Created!`);
        this.refreshDashboard();
        // Clear input
        document.getElementById('new-site-name').value = "";
    }

    registerEmployee() {
        const username = document.getElementById('new-emp-username').value.trim().toLowerCase();
        const email = document.getElementById('new-emp-email').value.trim();
        const siteSelect = document.getElementById('new-emp-site');
        const siteId = siteSelect.value;
        const company = this.mockDB.companies[this.currentUser.companyId];

        if (!username || !email || !siteId) return alert("Fill all fields");

        let user = this.mockDB.users[username];

        // Scenario 1: User doesn't exist -> Create new
        if (!user) {
            user = {
                role: 'employee',
                companyId: this.currentUser.companyId,
                email: email,
                assignedSiteId: siteId,
                status: 'checked-out',
                verified: true
            };
            this.mockDB.users[username] = user;
        }
        // Scenario 2: User exists but unassigned -> Link
        else if (user.companyId === null) {
            user.companyId = this.currentUser.companyId;
            user.assignedSiteId = siteId;
            user.email = email;
        }
        // Scenario 3: User belongs to another company
        else if (user.companyId !== this.currentUser.companyId) {
            return alert(`User "${username}" belongs to another company!`);
        }
        // Scenario 4: User in this company -> Update site
        else {
            user.assignedSiteId = siteId;
            // Update in company list if exists
            const existing = company.employees.find(e => e.username === username);
            if (existing) existing.assignedSiteId = siteId;

            this.saveDB();
            this.refreshDashboard();
            alert(`Updated site for ${username}.`);
            return;
        }

        // Add to Company List if not present
        if (!company.employees) company.employees = [];
        if (!company.employees.find(e => e.username === username)) {
            company.employees.push({
                username,
                email,
                assignedSiteId: siteId
            });
        }

        this.saveDB();
        alert(`Employee ${username} linked successfully!`);
        this.refreshDashboard();

        // Clear inputs
        document.getElementById('new-emp-username').value = "";
        document.getElementById('new-emp-email').value = "";
    }

    removeEmployee(username) {
        if (!confirm(`Are you sure you want to remove ${username} from the team?\nThey will be permanently deleted.`)) return;

        // 1. Remove from Company List
        const company = this.mockDB.companies[this.currentUser.companyId];
        company.employees = company.employees.filter(e => e.username !== username);

        // 2. Remove from Global Users
        if (this.mockDB.users[username]) {
            delete this.mockDB.users[username];
        }

        this.saveDB();
        this.refreshDashboard();
        alert("Employee removed.");
    }

    // --- Employee Features ---

    checkIn() {
        if (!this.currentPosition) return alert("GPS not available.");

        const user = this.mockDB.users[this.currentUser.username];
        const company = this.mockDB.companies[this.currentUser.companyId];

        // Find assigned site
        const site = company.sites.find(s => s.id === user.assignedSiteId);

        if (!site) return alert("Error: Your assigned worksite was deleted or not found.");

        const dist = this.getDistanceFromLatLonInMiters(
            this.currentPosition.lat, this.currentPosition.lng,
            site.lat, site.lng
        );

        if (dist > this.MAX_DISTANCE_METERS) {
            return alert(`You are too far from ${site.name}! (${Math.round(dist)}m away)`);
        }

        // Success
        user.status = 'checked-in';
        user.checkInTime = Date.now();
        user.lastPing = Date.now();

        // Add log entry
        this.addLog(this.currentUser.companyId, this.currentUser.username, `Check-In @ ${site.name}`, new Date().toLocaleTimeString());
        this.saveDB();
        this.refreshDashboard();
    }

    checkOut(reason = "Check-Out") {
        if (!this.currentUser) return;
        const user = this.mockDB.users[this.currentUser.username];
        if (!user) return;

        user.status = 'checked-out';
        user.checkInTime = null;

        // Add log entry
        this.addLog(this.currentUser.companyId, this.currentUser.username, reason, new Date().toLocaleTimeString());

        this.saveDB();
        this.refreshDashboard();
    }

    addLog(companyId, username, action, time) {
        const company = this.mockDB.companies[companyId];
        if (!company.logs) company.logs = [];
        company.logs.unshift({ username, action, time });
        if (company.logs.length > 20) company.logs.pop();
    }

    checkGeofence() {
        if (!this.currentUser || this.currentUser.role !== 'employee') return;

        const user = this.mockDB.users[this.currentUser.username];
        if (!user || user.status !== 'checked-in') return;

        const company = this.mockDB.companies[this.currentUser.companyId];
        const site = company.sites.find(s => s.id === user.assignedSiteId);
        if (!site) return;

        // 1. Distance Check
        const dist = this.getDistanceFromLatLonInMiters(
            this.currentPosition.lat, this.currentPosition.lng,
            site.lat, site.lng
        );

        // Debug display
        const distElem = document.getElementById('debug-distance');
        if (distElem) distElem.innerText = `Distance to ${site.name}: ${Math.round(dist)}m`;

        if (dist > this.MAX_DISTANCE_METERS * 1.5) { // 1.5x buffer for drift
            // Auto Checkout
            this.checkOut(true);
            alert(`Auto-checkout: You left the ${site.name} boundaries.`);
        }
    }

    refreshDashboard() {
        if (!this.currentUser) return;

        // Manager Logic
        if (this.currentUser.role === 'manager') {
            const company = this.mockDB.companies[this.currentUser.companyId];

            // 1. Render Sites Config
            const siteSelect = document.getElementById('new-emp-site'); // The dropdown in Add Employee form
            if (siteSelect) {
                // Save current selection
                const currentVal = siteSelect.value;
                siteSelect.innerHTML = '<option value="" disabled selected>Select Worksite</option>';
                if (company.sites) {
                    company.sites.forEach(site => {
                        const opt = document.createElement('option');
                        opt.value = site.id;
                        opt.innerText = `${site.name} (${site.lat.toFixed(4)})`;
                        siteSelect.appendChild(opt);
                    });
                }
                // Restore if possible
                if (currentVal) siteSelect.value = currentVal;
            }

            // 2. Render Existing Sites List (Visual)
            const siteListDiv = document.getElementById('site-list-display');
            if (siteListDiv) {
                if (company.sites && company.sites.length > 0) {
                    siteListDiv.innerHTML = company.sites.map(s => `
                        <div style="background:rgba(0,0,0,0.1); padding:8px; margin-top:4px; border-radius:4px; font-size:0.9rem;">
                            📍 <strong>${s.name}</strong>
                        </div>
                     `).join('');
                } else {
                    siteListDiv.innerHTML = '<small>No sites configured.</small>';
                }
            }

            // 3. Render TEAM STATUS (Live Dashboard)
            const teamStatusDiv = document.getElementById('team-status-display');
            if (teamStatusDiv && company.sites) {
                let html = '';
                company.sites.forEach(site => {
                    // Filter employees for this site
                    const siteEmployees = company.employees.filter(emp => emp.assignedSiteId === site.id);

                    if (siteEmployees.length > 0) {
                        html += `<div style="margin-bottom:16px;">
                            <h3 style="font-size:1rem; color:var(--accent-yellow); border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:4px; margin-bottom:8px;">
                                📍 ${site.name}
                            </h3>`;

                        siteEmployees.forEach(emp => {
                            // Look up live status object
                            const realUser = this.mockDB.users[emp.username];
                            const isActive = realUser && realUser.status === 'checked-in';

                            html += `
                                <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.2); padding:10px; border-radius:8px; margin-bottom:6px;">
                                    <div>
                                        <span style="font-weight:600; font-size:1rem;">${emp.username}</span>
                                        <div style="font-size:0.8rem; color:var(--text-muted);">${isActive ? 'Active on site' : 'Not at site'}</div>
                                    </div>
                                    <div style="font-size:1.5rem;">
                                        ${isActive ? '🟢' : '🔴'}
                                    </div>
                                </div>
                            `;
                        });
                        html += `</div>`;
                    }
                });

                if (html === '') {
                    html = '<p class="text-muted" style="text-align:center;">No employees assigned to sites yet.</p>';
                }

                teamStatusDiv.innerHTML = html;
            }

            // 3. Render Logs
            const logList = document.getElementById('employee-list');
            if (company.logs && company.logs.length > 0) {
                let html = '<table class="logs-table"><tr><th>User</th><th>Action</th><th>Time</th></tr>';
                company.logs.slice().reverse().forEach(log => { // Show newest first
                    html += `<tr><td>${log.username}</td><td>${log.action}</td><td>${log.time}</td></tr>`;
                });
                html += '</table>';
                logList.innerHTML = html;
            } else {
                logList.innerHTML = '<p style="color: var(--text-muted); font-size: 0.9rem;">No entries yet.</p>';
            }

            // 4. Render Team Management List
            const teamList = document.getElementById('team-list-container');
            if (teamList) {
                if (company.employees && company.employees.length > 0) {
                    teamList.innerHTML = company.employees.map(emp => {
                        const siteName = company.sites.find(s => s.id === emp.assignedSiteId)?.name || 'Unknown Site';
                        return `
                        <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.2); padding:12px; margin-bottom:8px; border-radius:8px; border:1px solid var(--border-color);">
                            <div>
                                <div style="font-weight:bold; font-size:1rem;">${emp.username}</div>
                                <div style="font-size:0.8rem; color:var(--text-muted);">@ ${siteName}</div>
                            </div>
                            <button onclick="app.removeEmployee('${emp.username}')" style="background:var(--danger); border:none; color:white; padding:8px 12px; border-radius:6px; cursor:pointer;">🗑️</button>
                        </div>
                        `;
                    }).join('');
                } else {
                    teamList.innerHTML = '<p style="text-align:center; color: var(--text-muted);">No employees yet.</p>';
                }
            }

        }
        // Employee Logic
        else {
            const user = this.mockDB.users[this.currentUser.username] || { status: 'checked-out' };
            const isCheckedIn = user.status === 'checked-in';

            // UI Toggles
            document.getElementById('btn-checkin').style.display = isCheckedIn ? 'none' : 'block';
            document.getElementById('btn-checkout').style.display = isCheckedIn ? 'block' : 'none';
            document.getElementById('emp-timer').style.display = isCheckedIn ? 'block' : 'none';

            if (isCheckedIn) this.startTimer(user.checkInTime);
            else if (this.timerInterval) clearInterval(this.timerInterval);

            const statusText = document.getElementById('emp-status-text');
            const statusIcon = document.getElementById('emp-status-icon');
            const empBox = document.getElementById('emp-status-box');

            if (isCheckedIn) {
                statusText.innerText = "Checked In";
                statusIcon.innerText = "✅";
                empBox.style.background = "rgba(40, 167, 69, 0.2)";
            } else {
                statusText.innerText = "Checked Out";
                statusIcon.innerText = "🛑";
                empBox.style.background = "rgba(255, 77, 77, 0.1)";
            }
        }
    }

    startTimer(startTime) {
        if (this.timerInterval) clearInterval(this.timerInterval);

        const timerElem = document.getElementById('emp-timer');
        this.timerInterval = setInterval(() => {
            const now = Date.now();
            const diff = now - startTime;
            const hours = Math.floor(diff / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((diff % (1000 * 60)) / 1000);

            timerElem.innerText = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            if (hours >= 2) {
                timerElem.style.color = 'var(--danger-red)';
                timerElem.innerText += " (RE-CHECK REQUIRED)";
            }
        }, 1000);
    }

    // Debug Tool: Manual Override
    debugSetLocation(lat, lng) {
        this.currentPosition = { lat, lng };
        this.updateUIWithLocation();
        this.checkGeofence();
        alert(`Debug: Teleported to ${lat}, ${lng}`);
    }

    // --- Utils ---
    getDistanceFromLatLonInMiters(lat1, lon1, lat2, lon2) {
        var R = 6371; // Radius of the earth in km
        var dLat = this.deg2rad(lat2 - lat1);  // deg2rad below
        var dLon = this.deg2rad(lon2 - lon1);
        var a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this.deg2rad(lat1)) * Math.cos(this.deg2rad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2)
            ;
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        var d = R * c; // Distance in km
        return d * 1000; // Distance in meters
    }

    deg2rad(deg) {
        return deg * (Math.PI / 180)
    }
}

// Initialize with Error Handling
try {
    window.onerror = function (msg, url, line, col, error) {
        alert("⚠️ CRITICAL ERROR:\n" + msg + "\nLine: " + line);
        return false;
    };

    const app = new HRApp();
    window.app = app; // Expose for HTML onclick handlers
    console.log("App Initialized Successfully");
} catch (e) {
    alert("❌ STARTUP FAILED:\n" + e.message);
    console.error(e);
}
