import { supabase } from './supabase.js';
/**
 * The HR app
 * Core Logic - Handles State, Geolocation, and UI Updates.
 * Migrated to Supabase for data persistence
 */

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

        // OTP verification state
        this.pendingUser = null;
        this.pendingRegistration = null; // Store: { email, username, type: 'manager'|'employee', managerData }

        // Constants
        this.MAX_DISTANCE_METERS = 50; // Geofence radius

        // In-memory cache of managers and employees
        this.managers = {};
        this.employees = {};
        this.sites = {};
        this.companies = {};
        this.logs = {};

        // Wrap init in try-catch just in case
        try {
            this.initAsync();
        } catch (e) {
            alert("Init Error: " + e.message);
        }
    }

    async initAsync() {
        try {
            // Start GPS immediately (for Login Screen status)
            this.watchLocation();

            // Load initial data from Supabase
            await this.loadAllData();

            // Setup Supabase auth state listener for magic link redirect flow
            this.setupAuthStateListener();

            // Restore session if exists from localStorage
            const storedUser = localStorage.getItem('hrapp_user');
            if (storedUser) {
                this.currentUser = JSON.parse(storedUser);
                // Verify user still exists in Supabase
                const user = this.managers[this.currentUser.username] || this.employees[this.currentUser.username];
                if (user) {
                    this.showView(this.currentUser.role === 'manager' ? 'view-manager' : 'view-employee');
                    this.refreshDashboard();
                } else {
                    this.logout(); // Invalid session
                }
            } else {
                this.showView('view-auth'); // Default to Auth
            }
        } catch (error) {
            console.error('Error in initAsync:', error);
            alert('Initialization error: ' + error.message);
        }
    }

    // Setup Supabase Auth State Listener for Magic Link Flow
    setupAuthStateListener() {
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log('Auth state changed:', event, session);

            // Only handle the magic link verification callback event
            if (event === 'SIGNED_IN' && session && session.user) {
                const authUser = session.user;
                console.log('User signed in via magic link:', authUser.email);

                // Get or use pending registration data
                if (!this.pendingRegistration) {
                    console.log('No pending registration found, retrieving from storage if available');
                    const storedPending = localStorage.getItem('hrapp_pending_registration');
                    if (storedPending) {
                        this.pendingRegistration = JSON.parse(storedPending);
                        console.log('Restored pending registration:', this.pendingRegistration);
                    }
                }

                if (!this.pendingRegistration || (!this.pendingRegistration.type)) {
                    console.log('No pending registration found for auto-creation');
                    return;
                }

                // Handle Manager Registration via Magic Link
                if (this.pendingRegistration.type === 'manager') {
                    // Check if this manager already exists in the managers table
                    const existingManager = this.managers[this.pendingRegistration.username];

                    if (existingManager) {
                        console.log('Manager already exists in database, logging in...');
                        // User already exists, just log them in
                        this.currentUser = { username: this.pendingRegistration.username, ...existingManager };
                        localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));
                        this.clearPendingRegistration();
                        this.showView('view-manager');
                        this.refreshDashboard();
                        this.showToast('✅ Welcome back! You have been automatically logged in.', 'success');
                    } else {
                        console.log('Manager does not exist yet, creating from pending registration...');
                        // Manager doesn't exist, create their record using pending registration data
                        try {
                            this.pendingRegistration.managerData.verified = true;
                            await this.saveManager(
                                this.pendingRegistration.username,
                                this.pendingRegistration.managerData
                            );

                            console.log('Manager record created successfully');

                            // Get the newly created manager record
                            const newManager = this.managers[this.pendingRegistration.username];

                            // Log them in automatically
                            this.currentUser = { username: this.pendingRegistration.username, ...newManager };
                            localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));
                            this.clearPendingRegistration();

                            // Show success and redirect to dashboard
                            this.showView('view-manager');
                            this.refreshDashboard();
                            this.showToast(`✅ Account verified and created! Welcome to your dashboard.`, 'success');
                        } catch (error) {
                            console.error('Error creating manager record:', error);
                            this.showToast('❌ Failed to complete account setup: ' + error.message, 'error');
                        }
                    }
                }
                // Handle Employee Registration via Magic Link
                else if (this.pendingRegistration.type === 'employee') {
                    const existingEmployee = this.employees[this.pendingRegistration.username];

                    if (existingEmployee) {
                        console.log('Employee already exists in database, logging in...');
                        // User already exists, just log them in
                        this.currentUser = { username: this.pendingRegistration.username, ...existingEmployee };
                        localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));
                        this.clearPendingRegistration();
                        this.showView('view-employee');
                        this.refreshDashboard();
                        this.showToast('✅ Welcome back! You have been automatically logged in.', 'success');
                    } else {
                        console.log('Employee does not exist yet, creating from pending registration...');
                        // Employee doesn't exist, create their record using pending registration data
                        try {
                            this.pendingRegistration.employeeData.verified = true;
                            await this.saveEmployee(
                                this.pendingRegistration.username,
                                this.pendingRegistration.employeeData
                            );

                            console.log('Employee record created successfully');

                            // Get the newly created employee record
                            const newEmployee = this.employees[this.pendingRegistration.username];

                            // Log them in automatically
                            this.currentUser = { username: this.pendingRegistration.username, ...newEmployee };
                            localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));
                            this.clearPendingRegistration();

                            // Show success and redirect to dashboard
                            this.showView('view-employee');
                            this.refreshDashboard();
                            this.showToast(`✅ Account verified and created! Welcome to your dashboard.`, 'success');
                        } catch (error) {
                            console.error('Error creating employee record:', error);
                            this.showToast('❌ Failed to complete account setup: ' + error.message, 'error');
                        }
                    }
                }
            }
        });
    }

    // Helper: Clear pending registration data
    clearPendingRegistration() {
        this.pendingRegistration = null;
        this.pendingUser = null;
        localStorage.removeItem('hrapp_pending_registration');
    }

    // Load all data from Supabase into memory cache
    async loadAllData() {
        try {
            // Load managers
            const { data: managersData, error: managersError } = await supabase
                .from('managers')
                .select('*');
            if (managersError) throw managersError;
            managersData?.forEach(m => {
                this.managers[m.username] = m;
                if (!this.companies[m.company_id]) {
                    this.companies[m.company_id] = { sites: [], employees: [], logs: [] };
                }
            });

            // Load employees
            const { data: employeesData, error: employeesError } = await supabase
                .from('employees')
                .select('*');
            if (employeesError) throw employeesError;
            employeesData?.forEach(e => {
                this.employees[e.username] = e;
                if (e.company_id && !this.companies[e.company_id]) {
                    this.companies[e.company_id] = { sites: [], employees: [], logs: [] };
                }
                if (e.company_id && !this.companies[e.company_id].employees.includes(e.username)) {
                    this.companies[e.company_id].employees.push(e.username);
                }
            });

            // Load sites
            const { data: sitesData, error: sitesError } = await supabase
                .from('sites')
                .select('*');
            if (sitesError) throw sitesError;
            sitesData?.forEach(s => {
                this.sites[s.id] = s;
                if (s.company_id && this.companies[s.company_id]) {
                    if (!this.companies[s.company_id].sites.find(site => site.id === s.id)) {
                        this.companies[s.company_id].sites.push(s);
                    }
                }
            });

            // Load checkins/logs
            const { data: checkinsData, error: checkinsError } = await supabase
                .from('checkins')
                .select('*')
                .order('created_at', { ascending: false });
            if (checkinsError) throw checkinsError;
            checkinsData?.forEach(c => {
                if (!this.logs[c.company_id]) this.logs[c.company_id] = [];
                this.logs[c.company_id].push(c);
            });

            console.log('✅ Data loaded from Supabase');
        } catch (error) {
            console.error('Error loading data from Supabase, attempting localStorage fallback:', error);
            
            // Fallback to localStorage snapshot
            try {
                const snapshot = localStorage.getItem('hrapp_db_snapshot');
                if (snapshot) {
                    const data = JSON.parse(snapshot);
                    this.managers = data.managers || {};
                    this.employees = data.employees || {};
                    this.sites = data.sites || {};
                    this.logs = data.logs || {};
                    console.log('✅ Loaded from localStorage backup');
                    this.showToast('Using offline cache - some data may be outdated', 'warning');
                    return;
                }
            } catch (storageError) {
                console.error('Failed to load localStorage backup:', storageError);
            }
            
            alert('Warning: Could not load data from database: ' + error.message);
        }
    }

    // Helper: Get user object (manager or employee)
    getUserByUsername(username) {
        return this.managers[username] || this.employees[username];
    }

    // Helper: Build company object from cached data
    getCompanyData(companyId) {
        const company = this.companies[companyId] || { sites: [], employees: [], logs: [] };
        company.sites = Object.values(this.sites).filter(s => s.company_id === companyId);
        company.employees = (this.companies[companyId]?.employees || []).map(username => {
            const emp = this.employees[username];
            return emp ? { username: emp.username, contact: emp.email || emp.phone, assignedSiteId: emp.assigned_site_id } : null;
        }).filter(e => e);
        company.logs = (this.logs[companyId] || []).slice(0, 20).map(log => ({
            username: log.username,
            action: log.action,
            time: log.time
        }));
        return company;
    }

    // Save manager to Supabase
    async saveManager(username, managerData) {
        try {
            const insertData = { 
                username, 
                ...managerData,
                updated_at: new Date().toISOString()
            };
            console.log('Sending manager data to Supabase:', insertData);
            
            const { error } = await supabase
                .from('managers')
                .upsert(insertData, { 
                    onConflict: 'username' 
                });
                
            if (error) {
                console.error('Supabase returned error for managers upsert:', error);
                throw error;
            }
            
            console.log('Successfully saved manager to Supabase!');
            this.managers[username] = { username, ...managerData };
        } catch (error) {
            console.error('Error saving manager:', error);
            throw error;
        }
    }

    // Save employee to Supabase
    async saveEmployee(username, employeeData) {
        try {
            // Filter out fields that don't exist in Supabase schema
            const { history, ...dbData } = employeeData;
            
            const { error } = await supabase
                .from('employees')
                .upsert({ 
                    username, 
                    ...dbData,
                    updated_at: new Date().toISOString()
                }, { 
                    onConflict: 'username' 
                });
            if (error) throw error;
            // Keep the full data in memory cache
            this.employees[username] = { username, ...employeeData };
        } catch (error) {
            console.error('Error saving employee:', error);
            throw error;
        }
    }

    // Save site to Supabase
    async saveSite(siteData) {
        try {
            const { data, error } = await supabase
                .from('sites')
                .upsert({ 
                    ...siteData,
                    updated_at: new Date().toISOString()
                }, { 
                    onConflict: 'id' 
                });
            if (error) throw error;
            this.sites[siteData.id] = siteData;
        } catch (error) {
            console.error('Error saving site:', error);
            throw error;
        }
    }

    // Save checkin/log to Supabase
    async saveCheckin(checkinData) {
        try {
            const { error } = await supabase
                .from('checkins')
                .insert({ 
                    ...checkinData,
                    created_at: new Date().toISOString()
                });
            if (error) throw error;
            if (!this.logs[checkinData.company_id]) {
                this.logs[checkinData.company_id] = [];
            }
            this.logs[checkinData.company_id].unshift(checkinData);
        } catch (error) {
            console.error('Error saving checkin:', error);
            throw error;
        }
    }

    // Delete manager from Supabase
    async deleteManager(username) {
        try {
            const { error } = await supabase
                .from('managers')
                .delete()
                .eq('username', username);
            if (error) throw error;
            delete this.managers[username];
        } catch (error) {
            console.error('Error deleting manager:', error);
            throw error;
        }
    }

    // Delete employee from Supabase
    async deleteEmployee(username) {
        try {
            const { error } = await supabase
                .from('employees')
                .delete()
                .eq('username', username);
            if (error) throw error;
            delete this.employees[username];
        } catch (error) {
            console.error('Error deleting employee:', error);
            throw error;
        }
    }

    // Bulk save all in-memory data to Supabase (with fallback to localStorage)
    async saveDB() {
        try {
            // Save all managers
            for (const [username, manager] of Object.entries(this.managers)) {
                const { error } = await supabase
                    .from('managers')
                    .upsert({ username, ...manager, updated_at: new Date().toISOString() }, { onConflict: 'username' });
                if (error) throw error;
            }

            // Save all employees
            for (const [username, employee] of Object.entries(this.employees)) {
                const { error } = await supabase
                    .from('employees')
                    .upsert({ username, ...employee, updated_at: new Date().toISOString() }, { onConflict: 'username' });
                if (error) throw error;
            }

            // Save all sites
            for (const [siteId, site] of Object.entries(this.sites)) {
                const { error } = await supabase
                    .from('sites')
                    .upsert({ ...site, updated_at: new Date().toISOString() }, { onConflict: 'id' });
                if (error) throw error;
            }

            console.log('✅ All data synced to Supabase');
        } catch (error) {
            console.error('Error syncing to Supabase, falling back to localStorage:', error);
            // Fallback: Create a snapshot in localStorage for offline recovery
            try {
                const dbSnapshot = {
                    managers: this.managers,
                    employees: this.employees,
                    sites: this.sites,
                    logs: this.logs,
                    timestamp: new Date().toISOString()
                };
                localStorage.setItem('hrapp_db_snapshot', JSON.stringify(dbSnapshot));
                console.log('💾 Backed up to localStorage');
            } catch (storageError) {
                console.error('Failed to backup to localStorage:', storageError);
            }
        }
    }

    setupLocationWatcher() {
        // Deprecated helper, but kept for safety if legacy calls exist
        this.watchLocation();
    }

    // --- Authentication ---

    async registerNewCompany() {
        const companyName = document.getElementById('reg-company-name').value.trim();
        const managerName = document.getElementById('reg-manager-name').value.trim().toLowerCase();
        const managerEmail = document.getElementById('reg-manager-email').value.trim();
        const managerPassword = document.getElementById('reg-manager-password').value.trim();
        const companyIdInput = document.getElementById('reg-company-id').value.trim().toUpperCase();

        if (!companyName || !managerName || !managerEmail) {
            return alert("Please fill all fields (Company Name, Manager Username, and Email)");
        }

        if (!managerPassword) {
            return alert("Please create a password for your account.");
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(managerEmail)) {
            return alert("Please enter a valid email address");
        }
        
        // Check if manager already exists
        if (this.managers[managerName]) {
            return alert("Username already taken! Choose another manager username.");
        }

        try {
            // Use user-provided Company ID or generate one
            const companyId = companyIdInput || (companyName.substring(0, 4) + Math.floor(1000 + Math.random() * 9000)).toUpperCase();

            console.log('registerNewCompany: Sending OTP to email', managerEmail);
            // Send OTP via Supabase Auth
            const { data, error } = await supabase.auth.signInWithOtp({
                email: managerEmail,
                options: {
                    shouldCreateUser: true // Allow new users to receive OTP
                }
            });

            if (error) {
                console.error('registerNewCompany: Error sending OTP', error);
                throw error;
            }
            
            console.log('registerNewCompany: OTP sent successfully, data:', data);

            // Store pending registration data with ALL required fields
            this.pendingRegistration = {
                email: managerEmail,
                username: managerName,
                type: 'manager',
                companyId: companyId,
                companyName: companyName,
                managerData: {
                    company_id: companyId,
                    password: managerPassword,
                    role: 'manager',
                    name: managerName,
                    email: managerEmail,
                    verified: false
                }
            };

            // Persist to localStorage so it survives the redirect from magic link
            localStorage.setItem('hrapp_pending_registration', JSON.stringify(this.pendingRegistration));

            this.showToast(`✉️ OTP sent to ${managerEmail}. Check your inbox!`, 'success');
            this.showView('view-verify');
        } catch (error) {
            console.error('Error sending OTP:', error);
            alert('Failed to send verification code: ' + error.message);
        }
    }

    async registerNewEmployeeUser() {
        const username = document.getElementById('reg-emp-username-self').value.trim().toLowerCase();
        const email = document.getElementById('reg-emp-email-self').value.trim();
        const phone = document.getElementById('reg-emp-phone-self').value.trim();
        const passcode = document.getElementById('reg-emp-passcode-self').value.trim();

        if (!username) return alert("Please enter a username.");
        
        // Email is now required for OTP verification
        if (!email) {
            return alert("Email is required for verification. Please provide an email address.");
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return alert("Please enter a valid email address.");
        }
        
        if (this.employees[username] || this.managers[username]) {
            return alert("Username already taken!");
        }

        try {
            // Send OTP via Supabase Auth
            const { data, error } = await supabase.auth.signInWithOtp({
                email: email,
                options: {
                    shouldCreateUser: false // Don't auto-create user yet
                }
            });

            if (error) {
                throw error;
            }

            // Store pending registration data
            this.pendingRegistration = {
                email: email,
                username: username,
                type: 'employee',
                employeeData: {
                    email: email,
                    phone: phone || null,
                    passcode: passcode || null,
                    company_id: null,
                    assigned_site_id: null,
                    status: 'checked-out',
                    verified: false
                }
            };

            // Persist to localStorage so it survives the redirect from magic link
            localStorage.setItem('hrapp_pending_registration', JSON.stringify(this.pendingRegistration));

            this.showToast(`✉️ OTP sent to ${email}. Check your inbox!`, 'success');
            this.showView('view-verify');
        } catch (error) {
            console.error('Error sending OTP:', error);
            alert('Failed to send verification code: ' + error.message);
        }
    }

    // --- VERIFICATION ---
    async verifyAccount() {
        const codeInput = document.getElementById('verify-code').value.trim();

        if (!this.pendingRegistration) {
            return this.showView('view-auth');
        }

        if (!codeInput) {
            return alert("Please enter the verification code");
        }

        try {
            console.log('verifyAccount: Verifying OTP for email:', this.pendingRegistration.email);
            // Verify OTP with Supabase Auth
            const { data, error } = await supabase.auth.verifyOtp({
                email: this.pendingRegistration.email,
                token: codeInput,
                type: 'email'
            });

            if (error) {
                console.error('verifyAccount: Error verifying OTP', error);
                throw error;
            }
            console.log('verifyAccount: OTP verified successfully, data:', data);

            // OTP verified successfully! Now create the account
            if (this.pendingRegistration.type === 'manager') {
                // Create manager account
                this.pendingRegistration.managerData.verified = true;
                await this.saveManager(this.pendingRegistration.username, this.pendingRegistration.managerData);
                
                alert("✅ Email Verified Successfully!");
                alert(`🎉 Company "${this.pendingRegistration.companyName}" Created!\n\nCompany ID: ${this.pendingRegistration.companyId}\n\nRedirecting to your dashboard...`);
                
                // Log the user in immediately
                const user = this.managers[this.pendingRegistration.username];
                this.currentUser = { username: this.pendingRegistration.username, ...user };
                localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));
                
                // Clear pending registration
                this.clearPendingRegistration();

                // Redirect to manager dashboard
                this.showView('view-manager');
                if (this.refreshDashboard) this.refreshDashboard();
                return;
                
            } else if (this.pendingRegistration.type === 'employee') {
                // Create employee account
                this.pendingRegistration.employeeData.verified = true;
                await this.saveEmployee(this.pendingRegistration.username, this.pendingRegistration.employeeData);
                
                alert("✅ Email Verified Successfully!");
                alert(`🎉 Account Created!\n\nUsername: ${this.pendingRegistration.username}\n\nPlease login with your credentials.`);
                
                // Pre-fill login form if element exists
                const usernameField = document.getElementById('auth-username');
                if (usernameField) {
                    usernameField.value = this.pendingRegistration.username;
                }
            }

            // Clear pending registration
            this.clearPendingRegistration();

            // Return to login view
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

        // --- AUTO-DETECT COMPANY ID LOGIC ---
        const user = this.managers[username] || this.employees[username];
        if (!user) return alert("User not found! Please Register first.");

        if (!companyId) {
            // Try to find it from user record
            if (user.company_id) {
                companyId = user.company_id;
                companyInput.value = companyId; // Auto-fill UI
                alert(`ℹ️ Found Company ID: ${companyId}\nProcessing Login...`);
            } else {
                return alert("Welcome! You do not have a Company ID yet.\nPlease ask your Manager to link your account.");
            }
        }

        // --- STANDARD CHECKS ---
        if (user.company_id && user.company_id !== companyId) {
            return alert(`❌ Incorrect Company ID.\nThis user belongs to company: ${user.company_id}`);
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
        if (!user.company_id) {
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
            const company = this.companies[user.company_id];
            const site = Object.values(this.sites).find(s => s.id === user.assigned_site_id && s.company_id === user.company_id);

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
        this.clearPendingRegistration();
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

    async monitorGeofence() {
        const user = this.employees[this.currentUser.username];
        if (!user || user.status !== 'checked-in') return;

        const company = this.companies[this.currentUser.company_id];
        const site = Object.values(this.sites).find(s => s.id === user.assigned_site_id && s.company_id === user.company_id);
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
            await this.checkOut("Geofence Exit");
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

    async createSite() {
        const siteName = document.getElementById('new-site-name').value.trim();
        if (!siteName) return alert("Enter a Site Name");
        if (!this.currentPosition) return alert("Waiting for GPS signal...");

        // Guard against Null Island (0,0) or invalid coords
        if (Math.abs(this.currentPosition.lat) < 0.0001 && Math.abs(this.currentPosition.lng) < 0.0001) {
            return alert("⚠️ GPS Error: Your location is reading as (0,0). Please wait for a better signal.");
        }

        const newSite = {
            id: Date.now(),
            name: siteName,
            lat: this.currentPosition.lat,
            lng: this.currentPosition.lng,
            company_id: this.currentUser.company_id
        };

        try {
            await this.saveSite(newSite);
            alert(`Site "${siteName}" Created!`);
            this.refreshDashboard();
            // Clear input
            document.getElementById('new-site-name').value = "";
        } catch (error) {
            console.error('Error creating site:', error);
            alert('Failed to create site: ' + error.message);
        }
    }

    async updateSiteLocation(siteId) {
        if (!this.currentPosition) return alert("Waiting for GPS...");

        // Guard against Null Island
        if (Math.abs(this.currentPosition.lat) < 0.0001 && Math.abs(this.currentPosition.lng) < 0.0001) {
            return alert("⚠️ GPS Error: Your location is reading as (0,0). Please wait for a better signal.");
        }

        const site = this.sites[siteId];
        if (!site) return;

        if (!confirm(`Update location for "${site.name}" to your CURRENT position?\n\nNew Coords: ${this.currentPosition.lat.toFixed(6)}, ${this.currentPosition.lng.toFixed(6)}`)) return;

        try {
            site.lat = this.currentPosition.lat;
            site.lng = this.currentPosition.lng;
            await this.saveSite(site);
            this.refreshDashboard();
            alert(`Location for "${site.name}" updated!`);
        } catch (error) {
            console.error('Error updating site location:', error);
            alert('Failed to update location: ' + error.message);
        }
    }

    async registerEmployee() {
        const username = document.getElementById('new-emp-username').value.trim().toLowerCase();
        const contact = document.getElementById('new-emp-contact').value.trim();
        const siteSelect = document.getElementById('new-emp-site');
        const siteId = siteSelect.value;
        const passcode = document.getElementById('new-emp-passcode').value.trim(); // Optional

        if (!username || !contact || !siteId) return alert("Fill all fields");

        try {
            let user = this.employees[username];

            // Scenario 1: User doesn't exist -> Create new
            if (!user) {
                user = {
                    role: 'employee',
                    company_id: this.currentUser.company_id,
                    email: contact.includes('@') ? contact : null,
                    phone: !contact.includes('@') ? contact : null,
                    passcode: passcode || null,
                    assigned_site_id: siteId,
                    status: 'checked-out',
                    verified: true
                };
                await this.saveEmployee(username, user);
            }
            // Scenario 2: User exists but unassigned -> Link
            else if (user.company_id === null) {
                user.company_id = this.currentUser.company_id;
                user.assigned_site_id = siteId;
                user.email = contact.includes('@') ? contact : null;
                user.phone = !contact.includes('@') ? contact : null;
                await this.saveEmployee(username, user);
            }
            // Scenario 3: User belongs to another company
            else if (user.company_id !== this.currentUser.company_id) {
                return alert(`User "${username}" belongs to another company!`);
            }
            // Scenario 4: User in this company -> Update site
            else {
                user.assigned_site_id = siteId;
                await this.saveEmployee(username, user);
                this.refreshDashboard();
                alert(`Updated site for ${username}.`);
                return;
            }

            // Update company's employee list in cache
            if (!this.companies[this.currentUser.company_id].employees.includes(username)) {
                this.companies[this.currentUser.company_id].employees.push(username);
            }

            alert(`Employee ${username} linked successfully!`);
            this.refreshDashboard();

            // Clear inputs
            document.getElementById('new-emp-username').value = "";
            document.getElementById('new-emp-contact').value = "";
        } catch (error) {
            console.error('Error registering employee:', error);
            alert('Failed to register employee: ' + error.message);
        }
    }

    async removeEmployee(username) {
        if (!confirm(`Are you sure you want to remove ${username} from the team?\nThey will be permanently deleted.`)) return;

        try {
            // 1. Remove from Global Users
            await this.deleteEmployee(username);

            // 2. Remove from Company List
            const idx = this.companies[this.currentUser.company_id].employees.indexOf(username);
            if (idx > -1) {
                this.companies[this.currentUser.company_id].employees.splice(idx, 1);
            }

            this.refreshDashboard();
            alert("Employee removed.");
        } catch (error) {
            console.error('Error removing employee:', error);
            alert('Failed to remove employee: ' + error.message);
        }
    }

    // --- Employee Features ---

    async checkIn() {
        if (!this.currentPosition) return alert("GPS not available.");

        const user = this.employees[this.currentUser.username];
        const company = this.companies[this.currentUser.company_id];

        // Find assigned site
        const site = Object.values(this.sites).find(s => s.id === user.assigned_site_id && s.company_id === user.company_id);

        if (!site) return alert("Error: Your assigned worksite was deleted or not found.");

        const dist = this.getDistanceFromLatLonInMeters(
            this.currentPosition.lat, this.currentPosition.lng,
            site.lat, site.lng
        );

        if (dist > this.MAX_DISTANCE_METERS) {
            return alert(`You are too far from ${site.name}! (${Math.round(dist)}m away)`);
        }

        try {
            // Success
            user.status = 'checked-in';
            user.check_in_time = Date.now();
            user.last_ping = Date.now();

            await this.saveEmployee(this.currentUser.username, user);

            // Start Tracking History
            this.trackLocation(site.id); // Valid initial point
            if (this.trackingInterval) clearInterval(this.trackingInterval);
            this.trackingInterval = setInterval(() => {
                this.trackLocation(site.id);
            }, 300000); // Track every 5 minutes (300k ms)

            // Add log entry
            await this.saveCheckin({
                username: this.currentUser.username,
                company_id: this.currentUser.company_id,
                action: `Check-In @ ${site.name}`,
                time: new Date().toLocaleTimeString(),
                site_id: site.id
            });

            this.refreshDashboard();
        } catch (error) {
            console.error('Error checking in:', error);
            alert('Failed to check in: ' + error.message);
        }
    }

    async trackLocation(siteId) {
        if (!this.currentPosition || !this.currentUser) return;
        const user = this.employees[this.currentUser.username];
        if (!user) return;

        try {
            if (!user.history) user.history = [];

            user.history.push({
                lat: this.currentPosition.lat,
                lng: this.currentPosition.lng,
                time: new Date().toLocaleString(),
                siteId: siteId
            });

            // Limit history to last 50 points to save space
            if (user.history.length > 50) user.history.shift();
            
            await this.saveEmployee(this.currentUser.username, user);
        } catch (error) {
            console.error('Error tracking location:', error);
        }
    }

    async checkOut(reason = "Check-Out") {
        if (!this.currentUser) return;
        const user = this.employees[this.currentUser.username];
        if (!user) return;

        try {
            user.status = 'checked-out';
            user.check_in_time = null;

            // Stop Tracking
            if (this.trackingInterval) clearInterval(this.trackingInterval);

            await this.saveEmployee(this.currentUser.username, user);

            // Add log entry
            await this.saveCheckin({
                username: this.currentUser.username,
                company_id: this.currentUser.company_id,
                action: reason,
                time: new Date().toLocaleTimeString(),
                site_id: null
            });

            this.refreshDashboard();
        } catch (error) {
            console.error('Error checking out:', error);
            alert('Failed to check out: ' + error.message);
        }
    }

    viewEmployeeHistory(username) {
        const user = this.employees[username];
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

    refreshDashboard() {
        if (!this.currentUser) return;

        // Manager Logic
        if (this.currentUser.role === 'manager') {
            const company = this.getCompanyData(this.currentUser.company_id);

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
                            const realUser = this.employees[emp.username];
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
            const user = this.employees[this.currentUser.username] || { status: 'checked-out' };
            const isCheckedIn = user.status === 'checked-in';

            // UI Toggles
            const btnCheckin = document.getElementById('btn-checkin');
            const btnCheckout = document.getElementById('btn-checkout');
            const empTimer = document.getElementById('emp-timer');
            
            if (btnCheckin) btnCheckin.style.display = isCheckedIn ? 'none' : 'block';
            if (btnCheckout) btnCheckout.style.display = isCheckedIn ? 'block' : 'none';
            if (empTimer) empTimer.style.display = isCheckedIn ? 'block' : 'none';

            if (isCheckedIn) this.startTimer(user.check_in_time);
            else if (this.timerInterval) clearInterval(this.timerInterval);

            const statusText = document.getElementById('emp-status-text');
            const statusIcon = document.getElementById('emp-status-icon');
            const empBox = document.getElementById('emp-status-box');

            if (statusText && statusIcon && empBox) {
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
        alert(`Debug: Teleported to ${lat}, ${lng}`);
    }

    // Debug: Dump DB to console/alert for troubleshooting
    debugDumpDB() {
        try {
            console.log('Managers (in-memory):', this.managers);
            console.log('Employees (in-memory):', this.employees);
            console.log('Sites (in-memory):', this.sites);
            console.log('Logs (in-memory):', this.logs);
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
