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

        // Listen for storage changes (other tabs or background updates)
        window.addEventListener('storage', (e) => {
            try {
                if (e.key === 'hrapp_db') {
                    const newDB = JSON.parse(e.newValue);
                    if (newDB) {
                        this.mockDB = newDB;
                        console.log('hrapp_db updated from another context. Syncing...');
                        this.refreshDashboard();
                        this.showToast('Database updated from another tab', 'info');
                    }
                }
                if (e.key === 'hrapp_user') {
                    const newUser = JSON.parse(e.newValue);
                    if (newUser) {
                        this.currentUser = newUser;
                        console.log('hrapp_user updated from another context. Syncing user session...');
                        this.refreshDashboard();
                        this.showToast('User session changed in another tab', 'info');
                    }
                }
            } catch (err) {
                console.warn('Error handling storage event', err);
            }
        });
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
            verified: false,
            verifyCode: Math.floor(1000 + Math.random() * 9000).toString(),
            history: [] // Init History
        };

        // SIMULATE SENDING CODE
        alert(`📨 SIMULATION: Manager Verification Code: ${this.mockDB.users[managerName].verifyCode}`);

        this.saveDB();

        alert(`🎉 Company Created. Please Login to Verify your Email.`);
        document.getElementById('auth-username').value = managerName;
        document.getElementById('auth-company').value = companyId;
        this.showView('view-auth');
    }

    registerNewEmployeeUser() {
        const username = document.getElementById('reg-emp-username-self').value.trim().toLowerCase();
        const email = document.getElementById('reg-emp-email-self').value.trim();
        const phone = document.getElementById('reg-emp-phone-self').value.trim();
        const passcode = document.getElementById('reg-emp-passcode-self').value.trim();

        if (!username) return alert("Please enter a username.");
        if (!email && !phone) return alert("Please provide either Email OR Phone number.");
        if (this.mockDB.users[username]) return alert("Username already taken!");

        // Generate Verification Code
        const verifyCode = Math.floor(1000 + Math.random() * 9000).toString();

        // Create Unassigned User
        this.mockDB.users[username] = {
            role: 'employee',
            companyId: null,
            email: email,
            phone: phone,
            passcode: passcode || null, // Optional Passcode
            assignedSiteId: null,
            status: 'checked-out',
            verified: false, // Verification Required
            verifyCode: verifyCode, // Store the code
            history: [] // Init History
        };

        this.saveDB();

        // SIMULATE SENDING CODE
        const contact = email || phone;
        alert(`📨 SIMULATION: Verification Code sent to ${contact}.\n\nCode: ${verifyCode}`);
        console.log(`[SIMULATION] Code for ${username}: ${verifyCode}`);

        alert(`🎉 Account Created! Please Login to Verify.`);
        this.showView('view-auth');
    }

    // --- VERIFICATION ---
    verifyAccount() {
        const codeInput = document.getElementById('verify-code').value.trim();

        if (!this.pendingUser) return this.showView('view-auth');

        // Get Latest User Data
        const user = this.mockDB.users[this.pendingUser.username];

        // Check Code
        if (codeInput !== user.verifyCode && codeInput !== "1234") { // Keep 1234 as master backdoor for testing
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

        // --- PASSCODE CHECK (Optional) ---
        if (user.passcode) {
            const passInput = document.getElementById('auth-passcode').value.trim();
            if (!passInput) return alert(`🔒 This account is protected.\nEnter your Passcode to login.`);
            if (passInput !== user.passcode) return alert(`❌ Invalid Passcode.`);
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

            const dist = this.getDistanceFromLatLonInMeters(
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
        // User requested to REMOVE auto-checkout on logout
        // The employee remains 'checked-in' even if they log out of the device.

        this.currentUser = null;
        localStorage.removeItem('hrapp_user');
        this.showView('view-auth');
        // Stop timer
        if (this.timerInterval) clearInterval(this.timerInterval);
    }

    // --- Geolocation ---

    watchLocation() {
        // 1. Check Secure Context (Required for Geolocation)
        if (!window.isSecureContext && window.location.hostname !== 'localhost') {
            const statusEl = document.getElementById('auth-gps-status');
            if (statusEl) statusEl.innerHTML = `<span style="color:var(--danger)">⚠️ Error: App must use HTTPS.</span>`;
            return alert("GPS REQUIREMENT MISSING:\n\nThis app must be run over HTTPS (Secure Encription) to use Location features.\n\nPlease check your URL.");
        }

        if (!navigator.geolocation) {
            alert("Geolocation is not supported by your browser");
            return;
        }

        // Update UI
        const statusEl = document.getElementById('auth-gps-status');
        if (statusEl) statusEl.innerHTML = `<span>🔄 Trying High Precision GPS... (5s)</span>`;

        // AGGRESSIVE STRATEGY: Try High Accuracy for 5s
        const options = {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 5000
        };

        this.watchId = navigator.geolocation.watchPosition(
            (position) => {
                this.currentPosition = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };
                this.updateUIWithLocation();

                if (this.currentUser && this.currentUser.role === 'employee') {
                    this.monitorGeofence();
                }
            },
            (error) => {
                console.error("GPS Watch Error:", error);

                // If High Accuracy fails (timeout or unavailable), switch to Low immediately
                if (error.code === 3 || error.code === 2) {
                    if (statusEl) statusEl.innerHTML = `<span>📶 Switching to WiFi/Cell Network...</span>`;
                    console.log("High Acc failed. Falling back to Low Accuracy...");

                    navigator.geolocation.clearWatch(this.watchId); // Stop broken watcher

                    // Start Low Accuracy Watcher with VERY permissible options
                    this.watchId = navigator.geolocation.watchPosition(
                        (pos) => {
                            this.currentPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                            this.updateUIWithLocation();
                            if (this.currentUser && this.currentUser.role === 'employee') {
                                this.monitorGeofence();
                            }
                        },
                        (err) => {
                            console.error("Low accuracy also failed", err);
                            let lowMsg = "Unknown Error";
                            if (err.code === 1) lowMsg = "Permission Denied";
                            if (err.code === 2) lowMsg = "Signal Unavailable";
                            if (err.code === 3) lowMsg = "Timeout";

                            if (statusEl) {
                                statusEl.innerHTML = `
                                    <div class="gps-status-message gps-status-warning">
                                        <span>⚠️ Failed: ${lowMsg}</span>
                                        <div style="display:flex; gap:8px; justify-content:center; margin-top:4px;">
                                            <button onclick="app.watchLocation()" class="btn-retry-gps">RETRY</button>
                                            <button onclick="app.useMockLocation()" class="btn-retry-gps" style="background:var(--primary-gradient); border:none;">USE MOCK LOC</button>
                                        </div>
                                    </div>`;
                            }
                        },
                        {
                            enableHighAccuracy: false,
                            timeout: 60000, // Wait up to 60s for anything
                            maximumAge: Infinity // Accept cached positions
                        }
                    );
                } else {
                    // Denied (Code 1) -> User must fix settings
                    let msg = "GPS Error";
                    if (error.code === 1) msg = "⚠️ Location Permission Denied.";
                    if (statusEl) statusEl.innerHTML = `
                        <div class="gps-status-message gps-status-warning" style="background: rgba(239, 68, 68, 0.2); border: 1px solid var(--danger);">
                            <div style="font-weight:bold;">⚠️ GPS Error ${error.code}: ${msg}</div>
                            <button onclick="app.useMockLocation()" class="btn-retry-gps" style="margin-top:4px; width:100%; background:var(--primary);">USE MOCK LOCATION</button>
                        </div>`;
                }
            },
            options
        );
    }

    useMockLocation() {
        // Fallback for testing/dev environments without GPS
        this.currentPosition = { lat: 40.7128, lng: -74.0060 }; // NYC
        alert("⚠️ USING MOCK LOCATION (New York)\n\nThis allows you to test the app logic without real GPS.");
        this.updateUIWithLocation();
        if (this.currentUser && this.currentUser.role === 'employee') {
            this.monitorGeofence();
        }
        const statusEl = document.getElementById('auth-gps-status');
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--success)">✅ Mock Location Active</span>`;
    }

    monitorGeofence() {
        const user = this.mockDB.users[this.currentUser.username];
        if (user.status !== 'checked-in') return;

        const company = this.mockDB.companies[this.currentUser.companyId];
        const site = company.sites.find(s => s.id === user.assignedSiteId);
        if (!site) return;

        if (!this.currentPosition) return; // Safety: require position to compute distance

        const dist = this.getDistanceFromLatLonInMeters(
            this.currentPosition.lat, this.currentPosition.lng,
            site.lat, site.lng
        );

        // Auto Logout if outside geofence (Strict 100m)
        if (dist > this.MAX_DISTANCE_METERS) {
            // Warning and Auto-Checkout (Stop Timer), but DO NOT kick to login screen
            alert(`⚠️ GEOCONFIG ALERT\n\nYou have left the worksite boundary (${Math.round(dist)}m).\n\nYour shift has been PAUSED (Auto Check-Out).`);
            this.checkOut("Geofence Exit");
            // LEAVE USER LOGGED IN so they can see what happened
            // this.logout(); // REMOVED
        }
    }

    // --- View Management ---

    showView(viewId) {
        document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
        const el = document.getElementById(viewId);
        if (!el) {
            console.warn('showView: element not found', viewId);
            return;
        }
        el.classList.add('active');
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
            statusEl.innerHTML = `<span class="t-success">✅ GPS Active</span> <span class="monospace-text">${this.currentPosition.lat.toFixed(4)}...</span>`;
            statusEl.classList.remove('gps-status-warning');
            statusEl.classList.add('gps-status-success');
        }
    }

    // --- Manager Features ---

    createSite() {
        const siteName = document.getElementById('new-site-name').value.trim();
        if (!siteName) return alert("Enter a Site Name");
        if (!this.currentPosition) return alert("Waiting for GPS signal...");

        // Guard against Null Island (0,0) or invalid coords
        if (Math.abs(this.currentPosition.lat) < 0.0001 && Math.abs(this.currentPosition.lng) < 0.0001) {
            return alert("⚠️ GPS Error: Your location is reading as (0,0). Please wait for a better signal.");
        }

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

    updateSiteLocation(siteId) {
        if (!this.currentPosition) return alert("Waiting for GPS...");

        // Guard against Null Island
        if (Math.abs(this.currentPosition.lat) < 0.0001 && Math.abs(this.currentPosition.lng) < 0.0001) {
            return alert("⚠️ GPS Error: Your location is reading as (0,0). Please wait for a better signal.");
        }

        const company = this.mockDB.companies[this.currentUser.companyId];
        const site = company.sites.find(s => s.id === siteId);
        if (!site) return;

        if (!confirm(`Update location for "${site.name}" to your CURRENT position?\n\nNew Coords: ${this.currentPosition.lat.toFixed(6)}, ${this.currentPosition.lng.toFixed(6)}`)) return;

        site.lat = this.currentPosition.lat;
        site.lng = this.currentPosition.lng;
        this.saveDB();
        this.refreshDashboard();
        alert(`Location for "${site.name}" updated!`);
    }

    registerEmployee() {
        const username = document.getElementById('new-emp-username').value.trim().toLowerCase();
        const contact = document.getElementById('new-emp-contact').value.trim();
        const siteSelect = document.getElementById('new-emp-site');
        const siteId = siteSelect.value;
        const passcode = document.getElementById('new-emp-passcode').value.trim(); // Optional
        const company = this.mockDB.companies[this.currentUser.companyId];

        if (!username || !contact || !siteId) return alert("Fill all fields");

        let user = this.mockDB.users[username];

        // Scenario 1: User doesn't exist -> Create new
        if (!user) {
            user = {
                role: 'employee',
                companyId: this.currentUser.companyId,
                email: contact.includes('@') ? contact : null,
                phone: !contact.includes('@') ? contact : null,
                passcode: passcode || null,
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
            user.email = contact.includes('@') ? contact : null;
            user.phone = !contact.includes('@') ? contact : null;
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
                contact: contact,
                assignedSiteId: siteId
            });
        }

        this.saveDB();
        alert(`Employee ${username} linked successfully!`);
        this.refreshDashboard();

        // Clear inputs
        document.getElementById('new-emp-username').value = "";
        document.getElementById('new-emp-contact').value = "";
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
        const site = company?.sites.find(s => s.id === user.assignedSiteId);

        if (!site) return alert("Error: Your assigned worksite was deleted or not found.");

        const dist = this.getDistanceFromLatLonInMeters(
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

        // Start Tracking History
        this.trackLocation(site.id); // Valid initial point
        if (this.trackingInterval) clearInterval(this.trackingInterval);
        this.trackingInterval = setInterval(() => {
            this.trackLocation(site.id);
        }, 300000); // Track every 5 minutes (300k ms)

        // Add log entry
        this.addLog(this.currentUser.companyId, this.currentUser.username, `Check-In @ ${site.name}`, new Date().toLocaleTimeString());
        this.saveDB();
        this.refreshDashboard();
    }

    trackLocation(siteId) {
        if (!this.currentPosition || !this.currentUser) return;
        const user = this.mockDB.users[this.currentUser.username];
        if (!user) return;

        if (!user.history) user.history = [];

        user.history.push({
            lat: this.currentPosition.lat,
            lng: this.currentPosition.lng,
            time: new Date().toLocaleString(),
            siteId: siteId
        });

        // Limit history to last 50 points to save space
        if (user.history.length > 50) user.history.shift();
        this.saveDB();
    }

    checkOut(reason = "Check-Out") {
        if (!this.currentUser) return;
        const user = this.mockDB.users[this.currentUser.username];
        if (!user) return;

        user.status = 'checked-out';
        user.checkInTime = null;

        // Stop Tracking
        if (this.trackingInterval) clearInterval(this.trackingInterval);

        // Add log entry
        this.addLog(this.currentUser.companyId, this.currentUser.username, reason, new Date().toLocaleTimeString());

        this.saveDB();
        this.refreshDashboard();
    }

    viewEmployeeHistory(username) {
        const user = this.mockDB.users[username];
        if (!user || !user.history || user.history.length === 0) {
            return alert(`No history found for ${username}.`);
        }

        // Simple Alert View for now (or a modal if preferred)
        let msg = `📜 Location History for ${username}:\n\n`;
        user.history.slice().reverse().forEach(pt => {
            msg += `• ${pt.time}: ${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}\n`;
        });

        alert(msg);
        // Ideally, we would switch to a dedicated view
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

        if (!this.currentPosition) return; // Safety: require position to compute distance

        // 1. Distance Check
        const dist = this.getDistanceFromLatLonInMeters(
            this.currentPosition.lat, this.currentPosition.lng,
            site.lat, site.lng
        );

        // Debug display
        const distElem = document.getElementById('debug-distance');
        if (distElem) distElem.innerText = `Distance to ${site.name}: ${Math.round(dist)}m`;

        if (dist > this.MAX_DISTANCE_METERS) {
            // Auto Logout
            alert(`⚠️ Debug Auto-Logout: You left the ${site.name} boundaries.`);
            this.logout();
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
                        <div class="site-item">
                            <div>
                                📍 <strong>${s.name}</strong>
                                <div class="text-small text-muted" style="margin-top:4px;">${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}</div>
                            </div>
                            <button class="btn-outline text-small" onclick="app.updateSiteLocation('${s.id}')">Update Loc</button>
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
                        html += `<div class="site-status-group">
                            <h3 class="site-header">
                                📍 ${site.name}
                            </h3>`;

                        siteEmployees.forEach(emp => {
                            // Look up live status object
                            const realUser = this.mockDB.users[emp.username];
                            const isActive = realUser && realUser.status === 'checked-in';

                            html += `
                                <div class="team-member-item">
                                    <div>
                                        <span class="team-member-name">${emp.username}</span>
                                        <div class="text-sub">${isActive ? 'Active on site' : 'Not at site'}</div>
                                    </div>
                                    <div class="team-member-status-icon">
                                        ${isActive ? '🟢' : '🔴'}
                                    </div>
                                </div>
                            `;
                        });
                        html += `</div>`;
                    }
                });

                if (html === '') {
                    html = '<p class="text-muted text-center">No employees assigned to sites yet.</p>';
                }

                teamStatusDiv.innerHTML = html;
            }

            // 4. Render Logs
            const logList = document.getElementById('employee-list');
            if (company.logs && company.logs.length > 0) {
                let html = '<table class="logs-table"><tr><th>User</th><th>Action</th><th>Time</th></tr>';
                company.logs.slice().reverse().forEach(log => { // Show newest first
                    html += `<tr><td>${log.username}</td><td>${log.action}</td><td>${log.time}</td></tr>`;
                });
                html += '</table>';
                logList.innerHTML = html;
            } else {
                logList.innerHTML = '<p class="text-muted text-small">No entries yet.</p>';
            }

            // 5. Render Team Management List
            const teamList = document.getElementById('team-list-container');
            if (teamList) {
                if (company.employees && company.employees.length > 0) {
                    teamList.innerHTML = company.employees.map(emp => {
                        const siteName = company.sites.find(s => s.id === emp.assignedSiteId)?.name || 'Unknown Site';
                        return `
                        <div class="team-member-item">
                            <div>
                                <div class="team-member-name">${emp.username}</div>
                                <div class="text-sub">@ ${siteName}</div>
                            </div>
                            <div>
                                <button onclick="app.viewEmployeeHistory('${emp.username}')" class="btn-outline text-small" style="margin-right:4px;">📜</button>
                                <button onclick="app.removeEmployee('${emp.username}')" class="btn-danger">🗑️</button>
                            </div>
                        </div>
                        `;
                    }).join('');
                } else {
                    teamList.innerHTML = '<p class="text-muted text-center">No employees yet.</p>';
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

    // Debug: Dump DB to console/alert for troubleshooting
    debugDumpDB() {
        try {
            const raw = localStorage.getItem('hrapp_db');
            console.log('hrapp_db (localStorage):', raw);
            console.log('mockDB (in-memory):', this.mockDB);
            alert('DB dumped to console. Open DevTools -> Console to inspect.');
        } catch (err) {
            alert('Failed to read DB: ' + err.message);
        }
    }

    // In-app toast notification
    showToast(message, type = 'info', duration = 4000) {
        try {
            const container = document.getElementById('toast-container');
            if (!container) return;

            const node = document.createElement('div');
            node.className = `toast ${type}`;
            node.innerText = message;

            container.appendChild(node);

            // Auto remove
            setTimeout(() => {
                try {
                    node.style.opacity = '0';
                    node.style.transform = 'translateY(-6px)';
                    setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 260);
                } catch (e) { /* ignore */ }
            }, duration);
        } catch (err) {
            console.warn('Toast failed', err);
        }
    }

    // --- Utils ---
    getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
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
    const app = new HRApp();
    window.app = app; // Expose for HTML onclick handlers
    console.log("App Initialized Successfully");
} catch (e) {
    alert("❌ STARTUP FAILED:\n" + e.message);
    console.error(e);
}
