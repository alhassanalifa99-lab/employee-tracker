import { supabase } from './supabase.js';

// Global Error Handler (Must be first)
window.onerror = function (msg, url, line, col, error) {
    alert("⚠️ CRITICAL ERROR:\n" + msg + "\nLine: " + line);
    return false;
};

class HRApp {
    constructor() {
        this.currentUser = null;
        this.currentPosition = null;
        this.watchId = null;
        this.pendingUser = null;
        this.pendingRegistration = null;
        this.MAX_DISTANCE_METERS = 50;
        this.managers = {};
        this.employees = {};
        this.sites = {};
        this.companies = {};
        this.logs = {};
        this.subscriptions = {};

        try {
            this.initAsync();
        } catch (e) {
            alert("Init Error: " + e.message);
        }
    }

    async initAsync() {
        try {
            this.watchLocation();
            await this.loadAllData();
            this.setupAuthStateListener();

            const storedUser = localStorage.getItem('hrapp_user');
            if (storedUser) {
                this.currentUser = JSON.parse(storedUser);
                const user = this.managers[this.currentUser.username] || this.employees[this.currentUser.username];
                if (user) {
                    this.showView(this.currentUser.role === 'manager' ? 'view-manager' : 'view-employee');
                    this.refreshDashboard();
                } else {
                    this.logout();
                }
            } else {
                this.showView('view-auth');
            }
        } catch (error) {
            console.error('Error in initAsync:', error);
            alert('Initialization error: ' + error.message);
        }
    }

    setupRealtimeSubscriptions() {
        try {
            if (!this.currentUser?.company_id) return;
            const companyId = this.currentUser.company_id;

            const employeesChannel = supabase.channel('employees_changes')
                .on('postgres_changes', {
                    event: '*', schema: 'public', table: 'employees',
                    filter: `company_id=eq.${companyId}`
                }, (payload) => {
                    const newData = payload.new;
                    if (newData?.username) {
                        this.employees[newData.username] = newData;
                        if (this.currentUser?.username === newData.username) {
                            this.currentUser = { ...this.currentUser, ...newData };
                            localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));
                        }
                        if (this.currentUser?.role === 'manager') this.refreshDashboard();
                    }
                }).subscribe();
            this.subscriptions.employees = employeesChannel;

            const checkinsChannel = supabase.channel('checkins_changes')
                .on('postgres_changes', {
                    event: 'INSERT', schema: 'public', table: 'checkins',
                    filter: `company_id=eq.${companyId}`
                }, (payload) => {
                    const newCheckin = payload.new;
                    if (newCheckin?.company_id) {
                        if (!this.logs[newCheckin.company_id]) this.logs[newCheckin.company_id] = [];
                        this.logs[newCheckin.company_id].unshift(newCheckin);
                        if (this.currentUser?.role === 'manager') this.refreshDashboard();
                    }
                }).subscribe();
            this.subscriptions.checkins = checkinsChannel;
        } catch (error) {
            console.error('Error setting up real-time subscriptions:', error);
        }
    }

    setupAuthStateListener() {
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log('Auth state changed:', event, session);
            if (event === 'SIGNED_IN' && session && session.user) {
                if (!this._otpJustVerified) {
                    console.log('Ignoring auto SIGNED_IN on page load');
                    return;
                }
                this._otpJustVerified = false;
            }
        });
    }

    clearPendingRegistration() {
        this.pendingRegistration = null;
        this.pendingUser = null;
        localStorage.removeItem('hrapp_pending_registration');
    }

    async loadAllData() {
        try {
            const { data: managersData, error: managersError } = await supabase.from('managers').select('*');
            if (managersError) throw managersError;
            managersData?.forEach(m => {
                this.managers[m.username] = m;
                if (!this.companies[m.company_id]) this.companies[m.company_id] = { sites: [], employees: [], logs: [] };
            });

            const { data: employeesData, error: employeesError } = await supabase.from('employees').select('*');
            if (employeesError) throw employeesError;
            employeesData?.forEach(e => {
                this.employees[e.username] = e;
                if (e.company_id && !this.companies[e.company_id]) this.companies[e.company_id] = { sites: [], employees: [], logs: [] };
                if (e.company_id && !this.companies[e.company_id].employees.includes(e.username)) this.companies[e.company_id].employees.push(e.username);
            });

            const { data: sitesData, error: sitesError } = await supabase.from('sites').select('*');
            if (sitesError) throw sitesError;
            sitesData?.forEach(s => {
                this.sites[s.id] = s;
                if (s.company_id && this.companies[s.company_id]) {
                    if (!this.companies[s.company_id].sites.find(site => site.id === s.id)) this.companies[s.company_id].sites.push(s);
                }
            });

            const { data: checkinsData, error: checkinsError } = await supabase.from('checkins').select('*').order('created_at', { ascending: false });
            if (checkinsError) throw checkinsError;
            checkinsData?.forEach(c => {
                if (!this.logs[c.company_id]) this.logs[c.company_id] = [];
                this.logs[c.company_id].push(c);
            });

            console.log('✅ Data loaded from Supabase');
        } catch (error) {
            console.error('Error loading data:', error);
            try {
                const snapshot = localStorage.getItem('hrapp_db_snapshot');
                if (snapshot) {
                    const data = JSON.parse(snapshot);
                    this.managers = data.managers || {};
                    this.employees = data.employees || {};
                    this.sites = data.sites || {};
                    this.logs = data.logs || {};
                    this.showToast('Using offline cache - some data may be outdated', 'warning');
                    return;
                }
            } catch (storageError) {
                console.error('Failed to load localStorage backup:', storageError);
            }
            alert('Warning: Could not load data from database: ' + error.message);
        }
    }

    getUserByUsername(username) {
        return this.managers[username] || this.employees[username];
    }

    getCompanyData(companyId) {
        const company = this.companies[companyId] || { sites: [], employees: [], logs: [] };
        company.sites = Object.values(this.sites).filter(s => s.company_id === companyId);
        company.employees = (this.companies[companyId]?.employees || []).map(username => {
            const emp = this.employees[username];
            return emp ? { username: emp.username, contact: emp.email || emp.phone, assignedSiteId: emp.assigned_site_id } : null;
        }).filter(e => e);
        company.logs = (this.logs[companyId] || []).slice(0, 20).map(log => ({
            username: log.username, action: log.action, time: log.time
        }));
        return company;
    }

    async saveManager(username, managerData) {
        try {
            const insertData = { username, ...managerData, updated_at: new Date().toISOString() };
            const { error } = await supabase.from('managers').upsert(insertData, { onConflict: 'username' });
            if (error) throw error;
            this.managers[username] = { username, ...managerData };
        } catch (error) {
            console.error('Error saving manager:', error);
            throw error;
        }
    }

    async createTrialSubscription(companyId) {
        try {
            const trialEndDate = new Date();
            trialEndDate.setDate(trialEndDate.getDate() + 30);
            const subscriptionData = {
                company_id: companyId, status: 'trial',
                trial_end: trialEndDate.toISOString(), created_at: new Date().toISOString()
            };
            const { data, error } = await supabase.from('subscriptions').upsert(subscriptionData, { onConflict: 'company_id' });
            if (error) throw error;
            return data;
        } catch (error) {
            console.error('Error creating trial subscription:', error);
            throw error;
        }
    }

    async saveEmployee(username, employeeData) {
        try {
            const { history, ...dbData } = employeeData;
            const { error } = await supabase.from('employees').upsert({
                username, ...dbData, updated_at: new Date().toISOString()
            }, { onConflict: 'username' });
            if (error) throw error;
            this.employees[username] = { username, ...employeeData };
        } catch (error) {
            console.error('Error saving employee:', error);
            throw error;
        }
    }

    async saveSite(siteData) {
        try {
            const { error } = await supabase.from('sites').upsert({ ...siteData, updated_at: new Date().toISOString() }, { onConflict: 'id' });
            if (error) throw error;
            this.sites[siteData.id] = siteData;
        } catch (error) {
            console.error('Error saving site:', error);
            throw error;
        }
    }

    async saveCheckin(checkinData) {
        try {
            const { error } = await supabase.from('checkins').insert({ ...checkinData, created_at: new Date().toISOString() });
            if (error) throw error;
            if (!this.logs[checkinData.company_id]) this.logs[checkinData.company_id] = [];
            this.logs[checkinData.company_id].unshift(checkinData);
        } catch (error) {
            console.error('Error saving checkin:', error);
            throw error;
        }
    }

    async deleteEmployee(username) {
        try {
            const { error } = await supabase.from('employees').delete().eq('username', username);
            if (error) throw error;
            delete this.employees[username];
        } catch (error) {
            console.error('Error deleting employee:', error);
            throw error;
        }
    }

    setupLocationWatcher() { this.watchLocation(); }

    // --- Authentication ---

    async registerNewCompany() {
        const companyName = document.getElementById('reg-company-name').value.trim();
        const managerName = document.getElementById('reg-manager-name').value.trim().toLowerCase();
        const managerEmail = document.getElementById('reg-manager-email').value.trim();
        const managerPassword = document.getElementById('reg-manager-password').value.trim();
        const companyIdInput = document.getElementById('reg-company-id').value.trim().toUpperCase();

        if (!companyName || !managerName || !managerEmail) return alert("Please fill all fields");
        if (!managerPassword) return alert("Please create a password for your account.");

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(managerEmail)) return alert("Please enter a valid email address");
        if (this.managers[managerName]) return alert("Username already taken!");

        try {
            const { data: existingEmails, error: queryError } = await supabase.from('managers').select('email').eq('email', managerEmail).limit(1);
            if (queryError) return alert("Error checking email: " + queryError.message);
            if (existingEmails && existingEmails.length > 0) return alert("This email is already registered.");
        } catch (error) {
            return alert("Error validating email: " + error.message);
        }

        try {
            const companyId = companyIdInput || (companyName.substring(0, 4) + Math.floor(1000 + Math.random() * 9000)).toUpperCase();
            const { data, error } = await supabase.auth.signInWithOtp({
                email: managerEmail,
                options: { shouldCreateUser: true, emailRedirectTo: null }
            });
            if (error) throw error;

            this.pendingRegistration = {
                email: managerEmail, username: managerName, type: 'manager',
                company_id: companyId, company_name: companyName,
                managerData: { company_id: companyId, password: managerPassword, role: 'manager', name: managerName, email: managerEmail, verified: false }
            };
            localStorage.setItem('hrapp_pending_registration', JSON.stringify(this.pendingRegistration));
            this.showToast(`✉️ 6-digit OTP sent to ${managerEmail}. Check your inbox!`, 'success');
            this.showView('view-verify');
        } catch (error) {
            alert('Failed to send verification code: ' + error.message);
        }
    }

    async registerNewEmployeeUser() {
        const username = document.getElementById('reg-emp-username-self').value.trim().toLowerCase();
        const email = document.getElementById('reg-emp-email-self').value.trim();
        const phone = document.getElementById('reg-emp-phone-self').value.trim();
        const passcode = document.getElementById('reg-emp-passcode-self').value.trim();

        if (!username) return alert("Please enter a username.");
        if (!email) return alert("Email is required for verification.");

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return alert("Please enter a valid email address.");
        if (this.employees[username] || this.managers[username]) return alert("Username already taken!");

        try {
            const { data, error } = await supabase.auth.signInWithOtp({
                email: email,
                options: { shouldCreateUser: true, emailRedirectTo: null }
            });
            if (error) throw error;

            this.pendingRegistration = {
                email, username, type: 'employee',
                employeeData: { email, phone: phone || null, passcode: passcode || null, company_id: null, assigned_site_id: null, status: 'checked-out', verified: false }
            };
            localStorage.setItem('hrapp_pending_registration', JSON.stringify(this.pendingRegistration));
            this.showToast(`✉️ 6-digit OTP sent to ${email}. Check your inbox!`, 'success');
            this.showView('view-verify');
        } catch (error) {
            alert('Failed to send verification code: ' + error.message);
        }
    }

    async verifyAccount() {
        const codeInput = document.getElementById('verify-code').value.trim();
        if (!this.pendingRegistration) return this.showView('view-auth');
        if (!codeInput) return alert("Please enter the verification code");

        try {
            console.log('Verifying OTP for:', this.pendingRegistration.email);
            this._otpJustVerified = true;
            const { data, error } = await supabase.auth.verifyOtp({
                email: this.pendingRegistration.email,
                token: codeInput,
                type: 'email'
            });
            if (error) throw error;

            if (this.pendingRegistration.type === 'manager') {
                this.pendingRegistration.managerData.verified = true;
                await this.saveManager(this.pendingRegistration.username, this.pendingRegistration.managerData);
                await this.createTrialSubscription(this.pendingRegistration.company_id);

                alert("✅ Email Verified Successfully!");
                alert(`🎉 Company "${this.pendingRegistration.company_name}" Created!\n\nCompany ID: ${this.pendingRegistration.company_id}\n\nRedirecting to your dashboard...`);

                const user = this.managers[this.pendingRegistration.username];
                this.currentUser = { username: this.pendingRegistration.username, ...user };
                localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));
                this.clearPendingRegistration();
                this.setupRealtimeSubscriptions();
                this.showView('view-manager');
                this.refreshDashboard();
                return;

            } else if (this.pendingRegistration.type === 'employee') {
                this.pendingRegistration.employeeData.verified = true;
                await this.saveEmployee(this.pendingRegistration.username, this.pendingRegistration.employeeData);
                alert("✅ Email Verified Successfully!");
                alert(`🎉 Account Created!\n\nUsername: ${this.pendingRegistration.username}\n\nPlease login with your credentials.`);
                const usernameField = document.getElementById('auth-username');
                if (usernameField) usernameField.value = this.pendingRegistration.username;
            }

            this.clearPendingRegistration();
            this.showView('view-auth');
        } catch (error) {
            console.error('Error verifying OTP:', error);
            alert('❌ Invalid or expired verification code. Please try again.\n\nError: ' + error.message);
        }
    }

    login() {
        const usernameInput = document.getElementById('auth-username');
        const companyInput = document.getElementById('auth-company');
        const username = usernameInput.value.trim().toLowerCase();
        let companyId = companyInput.value.trim().toUpperCase();

        if (!username) return alert("Please enter your Username");

        const user = this.managers[username] || this.employees[username];
        if (!user) return alert("User not found! Please Register first.");

        if (!companyId) {
            if (user.company_id) {
                companyId = user.company_id;
                companyInput.value = companyId;
                alert(`ℹ️ Found Company ID: ${companyId}\nProcessing Login...`);
            } else {
                return alert("You do not have a Company ID yet.\nPlease ask your Manager to link your account.");
            }
        }

        if (user.company_id && user.company_id !== companyId) return alert(`❌ Incorrect Company ID.\nThis user belongs to: ${user.company_id}`);

        if (user.passcode) {
            const passInput = document.getElementById('auth-passcode').value.trim();
            if (!passInput) return alert(`🔒 This account is protected.\nEnter your Passcode to login.`);
            if (passInput !== user.passcode) return alert(`❌ Invalid Passcode.`);
        }

        if (user.verified === false) {
            this.pendingUser = { username, ...user };
            this.showView('view-verify');
            return;
        }

        if (!user.company_id) return alert(`You are not linked to a company yet.\nAsk your Manager to register you using username: "${username}".`);

        if (user.role === 'employee') {
            if (!this.currentPosition) {
                alert("📍 DETECTING LOCATION...\n\nPlease allow GPS access and wait a moment.");
                navigator.geolocation.getCurrentPosition(
                    (pos) => { this.currentPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude }; this.updateUIWithLocation(); alert("✅ GPS Linked! Click 'Login' again."); },
                    (err) => { alert("❌ GPS Error: " + err.message); },
                    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
                );
                return;
            }

            const site = Object.values(this.sites).find(s => String(s.id) === String(user.assigned_site_id) && s.company_id === user.company_id);
            if (!site) return alert("Error: Assigned Worksite not found. Contact Manager.");

            const dist = this.getDistanceFromLatLonInMeters(this.currentPosition.lat, this.currentPosition.lng, site.lat, site.lng);
            if (dist > this.MAX_DISTANCE_METERS) return alert(`🚫 ACCESS DENIED\n\nYou are ${Math.round(dist)} meters away from ${site.name}.\n\nYou must be within ${this.MAX_DISTANCE_METERS}m to log in.`);
        }

        this.currentUser = { username, ...user };
        localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));
        this.setupRealtimeSubscriptions();
        this.showView(user.role === 'manager' ? 'view-manager' : 'view-employee');
        this.refreshDashboard();
    }

    logout() {
        this.currentUser = null;
        this.clearPendingRegistration();
        localStorage.removeItem('hrapp_user');
        this.showView('view-auth');
        if (this.timerInterval) clearInterval(this.timerInterval);
        if (this.subscriptions.employees) supabase.removeChannel(this.subscriptions.employees);
        if (this.subscriptions.checkins) supabase.removeChannel(this.subscriptions.checkins);
    }

    // --- Geolocation ---

    watchLocation() {
        if (!window.isSecureContext && window.location.hostname !== 'localhost') {
            const statusEl = document.getElementById('auth-gps-status');
            if (statusEl) { statusEl.className = 'gps-pill error'; statusEl.innerHTML = `<span class="gps-dot"></span><span>HTTPS required for GPS</span>`; }
            return alert("GPS REQUIREMENT MISSING:\n\nThis app must be run over HTTPS to use Location features.");
        }

        if (!navigator.geolocation) { alert("Geolocation is not supported by your browser"); return; }

        const statusEl = document.getElementById('auth-gps-status');
        if (statusEl) { statusEl.className = 'gps-pill waiting'; statusEl.innerHTML = `<span class="gps-dot"></span><span>Acquiring GPS signal...</span>`; }

        const options = { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 };

        this.watchId = navigator.geolocation.watchPosition(
            (position) => {
                this.currentPosition = { lat: position.coords.latitude, lng: position.coords.longitude };
                this.updateUIWithLocation();
                if (this.currentUser && this.currentUser.role === 'employee') this.monitorGeofence();
            },
            (error) => {
                console.error("GPS Watch Error:", error);
                if (error.code === 3 || error.code === 2) {
                    if (statusEl) { statusEl.className = 'gps-pill waiting'; statusEl.innerHTML = `<span class="gps-dot"></span><span>Switching to network location...</span>`; }
                    navigator.geolocation.clearWatch(this.watchId);
                    this.watchId = navigator.geolocation.watchPosition(
                        (pos) => { this.currentPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude }; this.updateUIWithLocation(); if (this.currentUser && this.currentUser.role === 'employee') this.monitorGeofence(); },
                        (err) => {
                            let lowMsg = "Unknown Error";
                            if (err.code === 1) lowMsg = "Permission Denied";
                            if (err.code === 2) lowMsg = "Signal Unavailable";
                            if (err.code === 3) lowMsg = "Timeout";
                            if (statusEl) { statusEl.className = 'gps-pill error'; statusEl.innerHTML = `<span class="gps-dot"></span><span>GPS Failed: ${lowMsg}</span><button onclick="app.watchLocation()">RETRY</button>`; }
                        },
                        { enableHighAccuracy: false, timeout: 60000, maximumAge: Infinity }
                    );
                } else {
                    let msg = "GPS Error";
                    if (error.code === 1) msg = "Location permission denied";
                    if (statusEl) { statusEl.className = 'gps-pill error'; statusEl.innerHTML = `<span class="gps-dot"></span><span>${msg}</span><button onclick="app.useMockLocation()">USE MOCK</button>`; }
                }
            },
            options
        );
    }

    useMockLocation() {
        this.currentPosition = { lat: 40.7128, lng: -74.0060 };
        alert("⚠️ USING MOCK LOCATION (New York)\n\nThis allows you to test the app logic without real GPS.");
        this.updateUIWithLocation();
        if (this.currentUser && this.currentUser.role === 'employee') this.monitorGeofence();
        const statusEl = document.getElementById('auth-gps-status');
        if (statusEl) { statusEl.className = 'gps-pill success'; statusEl.innerHTML = `<span class="gps-dot"></span><span>Mock Location Active (NYC)</span>`; }
    }

    async monitorGeofence() {
        const user = this.employees[this.currentUser.username];
        if (!user || user.status !== 'checked-in') return;
        const site = Object.values(this.sites).find(s => String(s.id) === String(user.assigned_site_id) && s.company_id === user.company_id);
        if (!site || !this.currentPosition) return;
        const dist = this.getDistanceFromLatLonInMeters(this.currentPosition.lat, this.currentPosition.lng, site.lat, site.lng);
        if (dist > this.MAX_DISTANCE_METERS) {
            alert(`⚠️ GEOCONFIG ALERT\n\nYou have left the worksite boundary (${Math.round(dist)}m).\n\nYour shift has been PAUSED (Auto Check-Out).`);
            await this.checkOut("Geofence Exit");
        }
    }

    // --- View Management ---

    showView(viewId) {
        document.querySelectorAll('.view').forEach(el => { el.classList.remove('active'); el.style.display = 'none'; });
        const el = document.getElementById(viewId);
        if (!el) { console.warn('showView: element not found', viewId); return; }
        el.classList.add('active');

        const isDesktop = window.innerWidth >= 768;
        if (isDesktop) {
            if (viewId === 'view-manager') {
                el.style.display = 'grid'; el.style.gridTemplateColumns = '280px 1fr 1fr';
                el.style.height = 'calc(100vh - 73px)'; el.style.padding = '0';
                el.style.gap = '0'; el.style.overflow = 'hidden'; el.style.alignItems = 'start';
            } else if (viewId === 'view-employee') {
                el.style.display = 'grid'; el.style.gridTemplateColumns = '1fr 1fr';
                el.style.height = 'calc(100vh - 73px)'; el.style.padding = '0';
                el.style.gap = '0'; el.style.alignItems = 'start'; el.style.overflow = 'hidden';
            } else {
                el.style.display = 'grid'; el.style.gridTemplateColumns = '1fr 1fr';
                el.style.height = 'calc(100vh - 73px)'; el.style.padding = '0'; el.style.gap = '0';
            }
        } else {
            el.style.display = 'flex'; el.style.flexDirection = 'column';
            el.style.gap = '12px'; el.style.padding = '0 16px'; el.style.height = '';
        }
    }

    updateUIWithLocation() {
        if (!this.currentPosition) return;
        const text = `${this.currentPosition.lat.toFixed(6)}, ${this.currentPosition.lng.toFixed(6)}`;
        if (document.getElementById('manager-coords')) document.getElementById('manager-coords').innerText = text;
        if (document.getElementById('emp-coords')) document.getElementById('emp-coords').innerText = text;
        const statusEl = document.getElementById('auth-gps-status');
        if (statusEl) { statusEl.className = 'gps-pill success'; statusEl.innerHTML = `<span class="gps-dot"></span><span>GPS Active — ${this.currentPosition.lat.toFixed(4)}, ${this.currentPosition.lng.toFixed(4)}</span>`; }
    }

    // --- Manager Features ---

    async createSite() {
        const siteName = document.getElementById('new-site-name').value.trim();
        if (!siteName) return alert("Enter a Site Name");
        if (!this.currentPosition) return alert("Waiting for GPS signal...");
        if (Math.abs(this.currentPosition.lat) < 0.0001 && Math.abs(this.currentPosition.lng) < 0.0001) return alert("⚠️ GPS Error: Location reading as (0,0). Please wait.");

        const newSite = { id: Date.now(), name: siteName, lat: this.currentPosition.lat, lng: this.currentPosition.lng, company_id: this.currentUser.company_id };
        try {
            await this.saveSite(newSite);
            alert(`Site "${siteName}" Created!`);
            this.refreshDashboard();
            document.getElementById('new-site-name').value = "";
        } catch (error) { alert('Failed to create site: ' + error.message); }
    }

    async updateSiteLocation(siteId) {
        if (!this.currentPosition) return alert("Waiting for GPS...");
        if (Math.abs(this.currentPosition.lat) < 0.0001 && Math.abs(this.currentPosition.lng) < 0.0001) return alert("⚠️ GPS Error: Location reading as (0,0). Please wait.");

        const site = this.sites[siteId];
        if (!site) return;
        if (!confirm(`Update location for "${site.name}" to your CURRENT position?\n\nNew Coords: ${this.currentPosition.lat.toFixed(6)}, ${this.currentPosition.lng.toFixed(6)}`)) return;

        try {
            site.lat = this.currentPosition.lat; site.lng = this.currentPosition.lng;
            await this.saveSite(site);
            this.refreshDashboard();
            alert(`Location for "${site.name}" updated!`);
        } catch (error) { alert('Failed to update location: ' + error.message); }
    }

    async registerEmployee() {
        const username = document.getElementById('new-emp-username').value.trim().toLowerCase();
        const contact = document.getElementById('new-emp-contact').value.trim();
        const siteId = document.getElementById('new-emp-site').value;
        const passcode = document.getElementById('new-emp-passcode').value.trim();

        if (!username || !contact || !siteId) return alert("Fill all fields");

        try {
            let user = this.employees[username];
            if (!user) {
                user = { role: 'employee', company_id: this.currentUser.company_id, email: contact.includes('@') ? contact : null, phone: !contact.includes('@') ? contact : null, passcode: passcode || null, assigned_site_id: siteId, status: 'checked-out', verified: true };
                await this.saveEmployee(username, user);
            } else if (user.company_id === null) {
                user.company_id = this.currentUser.company_id; user.assigned_site_id = siteId;
                user.email = contact.includes('@') ? contact : null; user.phone = !contact.includes('@') ? contact : null;
                await this.saveEmployee(username, user);
            } else if (user.company_id !== this.currentUser.company_id) {
                return alert(`User "${username}" belongs to another company!`);
            } else {
                user.assigned_site_id = siteId;
                await this.saveEmployee(username, user);
                this.refreshDashboard();
                alert(`Updated site for ${username}.`);
                return;
            }

            if (!this.companies[this.currentUser.company_id].employees.includes(username)) this.companies[this.currentUser.company_id].employees.push(username);
            alert(`Employee ${username} linked successfully!`);
            this.refreshDashboard();
            document.getElementById('new-emp-username').value = "";
            document.getElementById('new-emp-contact').value = "";
        } catch (error) { alert('Failed to register employee: ' + error.message); }
    }

    async removeEmployee(username) {
        if (!confirm(`Are you sure you want to remove ${username}?\nThey will be permanently deleted.`)) return;
        try {
            await this.deleteEmployee(username);
            const idx = this.companies[this.currentUser.company_id].employees.indexOf(username);
            if (idx > -1) this.companies[this.currentUser.company_id].employees.splice(idx, 1);
            this.refreshDashboard();
            alert("Employee removed.");
        } catch (error) { alert('Failed to remove employee: ' + error.message); }
    }

    // --- Employee Features ---

    async checkIn() {
        if (!this.currentPosition) return alert("GPS not available.");
        const user = this.employees[this.currentUser.username];
        const site = Object.values(this.sites).find(s => String(s.id) === String(user.assigned_site_id) && s.company_id === user.company_id);
        if (!site) return alert("Error: Your assigned worksite was deleted or not found.");

        const dist = this.getDistanceFromLatLonInMeters(this.currentPosition.lat, this.currentPosition.lng, site.lat, site.lng);
        if (dist > this.MAX_DISTANCE_METERS) return alert(`You are too far from ${site.name}! (${Math.round(dist)}m away)`);

        try {
            const checkInTime = new Date().toISOString();
            user.status = 'checked-in'; user.check_in_time = checkInTime; user.last_ping = checkInTime;
            await this.saveEmployee(this.currentUser.username, user);
            this.trackLocation(site.id);
            if (this.trackingInterval) clearInterval(this.trackingInterval);
            this.trackingInterval = setInterval(() => this.trackLocation(site.id), 300000);
            await this.saveCheckin({ username: this.currentUser.username, company_id: this.currentUser.company_id, action: `Check-In @ ${site.name}`, time: new Date().toLocaleTimeString(), site_id: site.id });
            this.refreshDashboard();
        } catch (error) { alert('Failed to check in: ' + error.message); }
    }

    async trackLocation(siteId) {
        if (!this.currentPosition || !this.currentUser) return;
        const user = this.employees[this.currentUser.username];
        if (!user) return;
        try {
            if (!user.history) user.history = [];
            user.history.push({ lat: this.currentPosition.lat, lng: this.currentPosition.lng, time: new Date().toLocaleString(), siteId });
            if (user.history.length > 50) user.history.shift();
            await this.saveEmployee(this.currentUser.username, user);
        } catch (error) { console.error('Error tracking location:', error); }
    }

    toggleCheckoutReason() {
        const panel = document.getElementById('checkout-reason-panel');
        const button = document.getElementById('btn-toggle-reason');
        if (!panel) return;
        const expanded = panel.classList.toggle('expanded');
        if (expanded) { panel.style.maxHeight = panel.scrollHeight + 'px'; if (button) button.innerText = 'Hide reason for leaving'; }
        else { panel.style.maxHeight = '0'; if (button) button.innerText = '📝 Add reason for leaving'; }
    }

    collapseCheckoutReason() {
        const panel = document.getElementById('checkout-reason-panel');
        const button = document.getElementById('btn-toggle-reason');
        if (!panel) return;
        panel.classList.remove('expanded'); panel.style.maxHeight = '0';
        if (button) button.innerText = '📝 Add reason for leaving';
    }

    async checkOut(reason = null) {
        if (!this.currentUser) return;
        const user = this.employees[this.currentUser.username];
        if (!user) return;
        const reasonInput = document.getElementById('checkout-reason');
        const customReason = reasonInput?.value?.trim();
        const action = reason || (customReason ? `Site Exit • ${customReason}` : 'Check-Out');

        try {
            user.status = 'checked-out'; user.check_in_time = null; user.last_ping = new Date().toISOString();
            if (this.trackingInterval) clearInterval(this.trackingInterval);
            await this.saveEmployee(this.currentUser.username, user);
            await this.saveCheckin({ username: this.currentUser.username, company_id: this.currentUser.company_id, action, time: new Date().toLocaleTimeString(), site_id: null });
            if (reasonInput) reasonInput.value = '';
            this.collapseCheckoutReason();
            this.refreshDashboard();
        } catch (error) { alert('Failed to check out: ' + error.message); }
    }

    refreshDashboard() {
        if (!this.currentUser) return;

        if (this.currentUser.role === 'manager') {
            const company = this.getCompanyData(this.currentUser.company_id);

            // 1. Sites dropdown
            const siteSelect = document.getElementById('new-emp-site');
            if (siteSelect) {
                const currentVal = siteSelect.value;
                siteSelect.innerHTML = '<option value="" disabled selected>Select Worksite</option>';
                company.sites?.forEach(site => {
                    const opt = document.createElement('option');
                    opt.value = site.id; opt.innerText = `${site.name} (${site.lat.toFixed(4)})`;
                    siteSelect.appendChild(opt);
                });
                if (currentVal) siteSelect.value = currentVal;
            }

            // 2. Sites list
            const siteListDiv = document.getElementById('site-list-display');
            if (siteListDiv) {
                siteListDiv.innerHTML = company.sites?.length > 0
                    ? company.sites.map(s => `<div class="site-item"><div>📍 <strong>${s.name}</strong><div class="text-small text-muted" style="margin-top:4px;">${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}</div></div><button class="btn-outline text-small" onclick="app.updateSiteLocation('${s.id}')">Update Loc</button></div>`).join('')
                    : '<small>No sites configured.</small>';
            }

            // 3. Team status
            const teamStatusDiv = document.getElementById('team-status-display');
            if (teamStatusDiv && company.sites) {
                let html = '';
                company.sites.forEach(site => {
                    const siteEmployees = Object.values(this.employees).filter(emp => emp.company_id === this.currentUser.company_id && String(emp.assigned_site_id) === String(site.id));
                    if (siteEmployees.length > 0) {
                        html += `<div class="site-status-group"><h3 class="site-header">📍 ${site.name}</h3>`;
                        siteEmployees.forEach(emp => {
                            const isActive = emp.status === 'checked-in';
                            html += `<div class="team-member-item"><div><span class="team-member-name">${emp.username}</span><div class="text-sub">${isActive ? 'Active on site' : 'Not at site'}</div></div><div class="team-member-status-icon">${isActive ? '🟢' : '🔴'}</div></div>`;
                        });
                        html += `</div>`;
                    }
                });
                teamStatusDiv.innerHTML = html || '<p class="text-muted text-center">No employees assigned to sites yet.</p>';
            }

            // 4. Logs
            const logList = document.getElementById('employee-list');
            if (logList) {
                logList.innerHTML = company.logs?.length > 0
                    ? '<table class="logs-table"><tr><th>User</th><th>Action</th><th>Time</th></tr>' + company.logs.slice().reverse().map(log => `<tr><td>${log.username}</td><td>${log.action}</td><td>${log.time}</td></tr>`).join('') + '</table>'
                    : '<p class="text-muted text-small">No entries yet.</p>';
            }

            // 5. Team list
            const teamList = document.getElementById('team-list-container');
            if (teamList) {
                const companyEmployees = Object.values(this.employees).filter(emp => emp.company_id === this.currentUser.company_id);
                teamList.innerHTML = companyEmployees.length > 0
                    ? companyEmployees.map(emp => {
                        const siteName = company.sites.find(s => String(s.id) === String(emp.assigned_site_id))?.name || 'Unknown Site';
                        return `
                        <div class="team-member-item" style="flex-direction:column; align-items:stretch; gap:8px;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <div style="cursor:pointer;" onclick="app.toggleEmployeeHistory('${emp.username}')">
                                    <div class="team-member-name">${emp.username}</div>
                                    <div class="text-sub">@ ${siteName} — tap to view history</div>
                                </div>
                                <button onclick="app.removeEmployee('${emp.username}')" class="btn-danger btn-sm">🗑️</button>
                            </div>
                            <div id="history-${emp.username}" style="display:none; background:var(--surface-2); border-radius:var(--radius-sm); padding:12px; font-size:0.82rem; color:var(--text-muted);">
                                Loading...
                            </div>
                        </div>`;
                    }).join('')
                    : '<p class="text-muted text-center">No employees yet.</p>';
            }

        } else {
            const user = this.employees[this.currentUser.username] || { status: 'checked-out' };
            const isCheckedIn = user.status === 'checked-in';

            const btnCheckin = document.getElementById('btn-checkin');
            const btnCheckout = document.getElementById('btn-checkout');
            const empTimer = document.getElementById('emp-timer');
            if (btnCheckin) btnCheckin.style.display = isCheckedIn ? 'none' : 'block';
            if (btnCheckout) btnCheckout.style.display = isCheckedIn ? 'block' : 'none';
            if (empTimer) empTimer.style.display = isCheckedIn ? 'block' : 'none';

            if (!isCheckedIn) this.collapseCheckoutReason();
            if (isCheckedIn) this.startTimer(user.check_in_time);
            else if (this.timerInterval) clearInterval(this.timerInterval);

            const statusText = document.getElementById('emp-status-text');
            const statusIcon = document.getElementById('emp-status-icon');
            const empBox = document.getElementById('emp-status-box');
            if (statusText && statusIcon && empBox) {
                if (isCheckedIn) { statusText.innerText = "Checked In"; statusIcon.innerText = "✅"; empBox.style.background = "rgba(40, 167, 69, 0.2)"; }
                else { statusText.innerText = "Checked Out"; statusIcon.innerText = "🛑"; empBox.style.background = "rgba(255, 77, 77, 0.1)"; }
            }
        }
    }

    startTimer(startTime) {
        if (this.timerInterval) clearInterval(this.timerInterval);
        const timerElem = document.getElementById('emp-timer');
        this.timerInterval = setInterval(() => {
            const diff = Date.now() - startTime;
            const h = Math.floor(diff / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            timerElem.innerText = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
            if (h >= 2) { timerElem.style.color = 'var(--red)'; timerElem.innerText += " (RE-CHECK REQUIRED)"; }
        }, 1000);
    }

    debugSetLocation(lat, lng) {
        this.currentPosition = { lat, lng };
        this.updateUIWithLocation();
        alert(`Debug: Teleported to ${lat}, ${lng}`);
    }

    showToast(message, type = 'info', duration = 4000) {
        try {
            const container = document.getElementById('toast-container');
            if (!container) return;
            const node = document.createElement('div');
            node.className = `toast ${type}`; node.innerText = message;
            container.appendChild(node);
            setTimeout(() => { try { node.style.opacity = '0'; node.style.transform = 'translateY(-6px)'; setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 260); } catch (e) {} }, duration);
        } catch (err) { console.warn('Toast failed', err); }
    }

    // --- Utils ---

    getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = this.deg2rad(lat2 - lat1);
        const dLon = this.deg2rad(lon2 - lon1);
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(this.deg2rad(lat1)) * Math.cos(this.deg2rad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 1000;
    }

    deg2rad(deg) { return deg * (Math.PI / 180); }

    togglePanel(bodyId, iconId) {
        const el = document.getElementById(bodyId);
        const icon = document.getElementById(iconId);
        if (!el || !icon) return;
        if (el.style.display === 'none') { el.style.display = 'block'; icon.textContent = '−'; }
        else { el.style.display = 'none'; icon.textContent = '+'; }
    }

    toggleEmployeeHistory(username) {
        const el = document.getElementById(`history-${username}`);
        if (!el) return;
        if (el.style.display === 'none') {
            el.style.display = 'block';
            const user = this.employees[username];
            if (!user || !user.history || user.history.length === 0) {
                el.innerHTML = '<p style="color:var(--text-muted);">No location history yet.</p>';
                return;
            }
            el.innerHTML = user.history.slice().reverse().slice(0, 10).map(pt => `
                <div style="padding:6px 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between;">
                    <span>${pt.time}</span>
                    <span style="font-family:monospace;">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</span>
                </div>
            `).join('');
        } else {
            el.style.display = 'none';
        }
    }
}

// Initialize
try {
    const app = new HRApp();
    window.app = app;
    console.log("App Initialized Successfully");
} catch (e) {
    alert("❌ STARTUP FAILED:\n" + e.message);
    console.error(e);
}