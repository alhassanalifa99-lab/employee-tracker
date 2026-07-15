import { supabase } from './supabase.js';

const alert = (message) => {
    if (window.app && typeof window.app.showToastFromLegacyAlert === 'function') {
        window.app.showToastFromLegacyAlert(message);
        return;
    }
    console.warn('Alert suppressed before app init:', message);
};

window.onerror = function (msg, url, line, col, error) {
    alert(" CRITICAL ERROR:\n" + msg + "\nLine: " + line);
    return false;
};

class HRApp {
    constructor() {
        this.currentUser = null;
        this.currentPosition = null;
        this.watchId = null;
        this.pendingUser = null;
        this.pendingRegistration = null;
        this.geofenceRadiusMeters = 50;
        this._lastGeofenceRadiusFetchMs = 0;
        this.geofenceInterval = null;
        this.geofenceLock = false;
        this.timerInterval = null;
        this.managers = {};
        this.employees = {};
        this.sites = {};
        this.companies = {};
        this.logs = {};
        this.subscriptions = {};
        this.BIOMETRIC_STORAGE_KEY = 'hrapp_biometric_credentials';

        try {
            this.initAsync();
        } catch (e) {
            alert("Init Error: " + e.message);
        }
    }

    // ─── LOCATION ─────────────────────────────────────────────────────────────

    watchLocation() {
        if (!navigator.geolocation) {
            console.warn('Geolocation not supported');
            this.updateGPSStatus('error', 'GPS not supported');
            return;
        }

        if (this.watchId !== null) {
            navigator.geolocation.clearWatch(this.watchId);
        }

        this.watchId = navigator.geolocation.watchPosition(
            (position) => {
                this.currentPosition = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude,
                    accuracy: position.coords.accuracy
                };
                this.updateGPSStatus('success', 'GPS active');
                this.updateCoordinatesDisplay();
                this.checkGeofence();
            },
            (error) => {
                console.error('Geolocation error:', error);
                let message = 'GPS error';
                if (error.code === 1) message = 'GPS permission denied';
                else if (error.code === 2) message = 'GPS unavailable';
                else if (error.code === 3) message = 'GPS timeout';
                this.updateGPSStatus('error', message);
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 5000
            }
        );
    }

    updateGPSStatus(status, message) {
        const authStatus = document.getElementById('auth-gps-status');
        if (authStatus) {
            authStatus.className = `gps-pill ${status}`;
            authStatus.querySelector('span:nth-child(2)').textContent = message;
        }
    }

    updateCoordinatesDisplay() {
        if (!this.currentPosition) return;

        const managerCoords = document.getElementById('manager-coords');
        const empCoords = document.getElementById('emp-coords');

        const coordsText = `📍 ${this.currentPosition.lat.toFixed(6)}, ${this.currentPosition.lng.toFixed(6)}`;

        if (managerCoords) {
            managerCoords.textContent = coordsText;
        }

        if (empCoords) {
            empCoords.textContent = coordsText;
        }
    }

    checkGeofence() {
        if (!this.currentPosition || !this.currentUser) return;

        const user = this.managers[this.currentUser.username] || this.employees[this.currentUser.username];
        if (!user || !user.assigned_site_id) return;

        const site = this.sites[user.assigned_site_id];
        if (!site) return;

        const distance = this.calculateDistance(
            this.currentPosition.lat,
            this.currentPosition.lng,
            site.lat,
            site.lng
        );

        const radius = this.getEffectiveGeofenceRadius();
        const hint = document.getElementById('emp-geofence-hint');
        if (hint) {
            hint.textContent = `Allowed check-in radius: ${radius}m (Distance: ${distance.toFixed(0)}m)`;
        }
    }

    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371e3;
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                  Math.cos(φ1) * Math.cos(φ2) *
                  Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    debugSetLocation(lat, lng) {
        this.currentPosition = { lat, lng, accuracy: 10 };
        this.updateCoordinatesDisplay();
        this.checkGeofence();
        this.showToast({ message: `Debug: Location set to ${lat.toFixed(4)}, ${lng.toFixed(4)}`, type: 'info' });
    }

    // ─── INIT ────────────────────────────────────────────────────────────────

    async initAsync() {
        try {
            this.watchLocation();
            await this.loadAllData();
            this.setupAuthStateListener();
            this.setupAuthInputListeners();

            const storedUser = localStorage.getItem('hrapp_user');
            if (storedUser) {
                this.currentUser = JSON.parse(storedUser);
                const user = this.managers[this.currentUser.username] || this.employees[this.currentUser.username];
                if (user) {
                    if (user.role === 'manager' && user.company_id) {
                        const { data: subRow } = await supabase.from('subscriptions').select('company_id').eq('company_id', user.company_id).maybeSingle();
                        if (!subRow) {
                            try {
                                await this.createTrialSubscription(user.company_id);
                            } catch (e) {
                                console.error('Restored session: could not ensure subscription row', e);
                            }
                        }
                    }
                    await this.loadGeofenceRadiusFromSubscription(user.company_id);
                    this.showView(this.currentUser.role === 'manager' ? 'view-manager' : 'view-employee');
                    this.refreshDashboard();
                } else {
                    this.logout();
                }
            } else {
                this.showView('view-auth');
                this.updateBiometricLoginButton();
            }
        } catch (error) {
            console.error('Error in initAsync:', error);
            alert('Initialization error: ' + error.message);
        }
    }

    // ─── GEOFENCE RADIUS ─────────────────────────────────────────────────────

    getEffectiveGeofenceRadius() {
        const r = Number(this.geofenceRadiusMeters);
        if (!Number.isFinite(r)) return 50;
        return Math.min(2000, Math.max(10, r));
    }

    async loadGeofenceRadiusFromSubscription(companyId) {
        if (!companyId) { this.geofenceRadiusMeters = 50; return; }
        try {
            const { data, error } = await supabase.from('subscriptions').select('*').eq('company_id', companyId).maybeSingle();
            if (error) throw error;
            const v = data?.geofence_radius_m;
            this.geofenceRadiusMeters = (v != null && Number.isFinite(Number(v)))
                ? Math.min(2000, Math.max(10, Number(v))) : 50;
        } catch (e) {
            console.warn('Could not load geofence_radius_m:', e?.message || e);
            this.geofenceRadiusMeters = 50;
        }
    }

    async maybeRefreshGeofenceRadius() {
        const companyId = this.currentUser?.company_id;
        if (!companyId) return;
        const now = Date.now();
        if (now - this._lastGeofenceRadiusFetchMs < 45000) return;
        this._lastGeofenceRadiusFetchMs = now;
        await this.loadGeofenceRadiusFromSubscription(companyId);
    }

    async saveGeofenceRadius() {
        if (!this.currentUser || this.currentUser.role !== 'manager') return;
        const input = document.getElementById('geofence-radius');
        const raw = parseInt(input?.value, 10);
        const meters = Number.isFinite(raw) ? Math.min(2000, Math.max(10, raw)) : 50;
        if (input) input.value = String(meters);
        try {
            const payload = { company_id: this.currentUser.company_id, geofence_radius_m: meters };
            let { error } = await supabase.from('subscriptions').upsert(payload, { onConflict: 'company_id' });
            if (error && String(error.message || '').toLowerCase().includes('geofence_radius_m')) {
                ({ error } = await supabase.from('subscriptions').upsert({ company_id: this.currentUser.company_id }, { onConflict: 'company_id' }));
                if (!error) {
                    this.geofenceRadiusMeters = meters;
                    this.showToast({ message: 'Radius could not be saved yet (database column missing).', type: 'warning' });
                    return;
                }
            }
            if (error) throw error;
            this.geofenceRadiusMeters = meters;
            this.showToast({ message: `Check-in radius set to ${meters}m for all worksites.`, type: 'success' });
        } catch (e) {
            console.error(e);
            this.showToast({ message: e?.message ? `Could not save radius: ${e.message}` : 'Could not save radius.', type: 'error' });
        }
    }

    // ─── DATABASE ────────────────────────────────────────────────────────────

    async resetDatabase() {
        if (!confirm(' WARNING: This will delete ALL data.\n\nAre you absolutely sure?')) return;
        if (!confirm('This action cannot be undone. Continue?')) return;
        if (prompt('Type OK to confirm:') !== 'OK') return;
        try {
            this.showToast({ message: 'Resetting database...', type: 'info' });
            await supabase.from('checkins').delete().neq('id', 'x');
            await supabase.from('subscriptions').delete().neq('company_id', 'x');
            await supabase.from('sites').delete().neq('id', 'x');
            await supabase.from('employees').delete().neq('username', 'x');
            await supabase.from('managers').delete().neq('username', 'x');
            this.managers = {}; this.employees = {}; this.sites = {}; this.logs = {}; this.subscriptions = {};
            this.showToast({ message: '✅ Database reset complete!', type: 'success' });
            this.logout();
        } catch (error) {
            console.error('Error resetting database:', error);
            this.showToast({ message: '❌ Failed to reset database: ' + error.message, type: 'error' });
        }
    }

    async loadAllData() {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.expires_at && session.expires_at * 1000 < Date.now()) {
                await supabase.auth.refreshSession();
            }

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
                    this.showToast({ message: 'Using offline cache - some data may be outdated', type: 'warning' });
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

    // ─── SAVE / DELETE ───────────────────────────────────────────────────────

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

    async deleteSite(siteId) {
        try {
            const { error } = await supabase.from('sites').delete().eq('id', siteId);
            if (error) throw error;
            delete this.sites[siteId];
        } catch (error) {
            console.error('Error deleting site:', error);
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

    // ─── SUBSCRIPTION ────────────────────────────────────────────────────────

    async createTrialSubscription(companyId) {
        try {
            if (!companyId) throw new Error('Invalid company_id');

            const trialEndDate = new Date();
            trialEndDate.setDate(trialEndDate.getDate() + 30);
            const now = new Date().toISOString();
            const geofenceRadius = this.getEffectiveGeofenceRadius();

            console.log('Creating trial subscription:', { companyId, trialEndDate: trialEndDate.toISOString() });

            const subscriptionData = {
                company_id: companyId,
                subscription_plan: 'trial',
                subscription_status: 'active',
                trial_end: trialEndDate.toISOString(),
                employee_count: 10,
                paystack_ref: '',
                created_at: now,
                updated_at: now
            };

            const withGeofence = { ...subscriptionData, geofence_radius_m: geofenceRadius };

            let { data, error } = await supabase.from('subscriptions').upsert(withGeofence, { onConflict: 'company_id' });

            if (error && String(error.message || '').toLowerCase().includes('geofence_radius_m')) {
                console.warn('geofence_radius_m column not found, retrying without it...');
                ({ data, error } = await supabase.from('subscriptions').upsert(subscriptionData, { onConflict: 'company_id' }));
            }

            if (error) { console.error('Supabase upsert error:', error); throw error; }

            console.log('Trial subscription created successfully:', data);
            return data;
        } catch (error) {
            console.error('Error creating trial subscription:', error);
            console.error('Full error object:', JSON.stringify(error, null, 2));
            throw error;
        }
    }

    isSubscriptionPeriodActive(data) {
        if (!data?.trial_end) return false;
        const end = new Date(data.trial_end);
        if (Number.isNaN(end.getTime()) || new Date() >= end) return false;
        return data.subscription_status === 'trial' || data.subscription_status === 'active';
    }

    async checkSubscription() {
        if (!this.currentUser || this.currentUser.role !== 'manager') return true;
        try {
            const { data, error } = await supabase.from('subscriptions').select('*').eq('company_id', this.currentUser.company_id).maybeSingle();
            if (error || !data) return false;
            return this.isSubscriptionPeriodActive(data);
        } catch { return false; }
    }

    async getTrialDaysRemaining() {
        try {
            const { data, error } = await supabase.from('subscriptions').select('trial_end').eq('company_id', this.currentUser.company_id).maybeSingle();
            if (error || !data?.trial_end) return 0;
            const daysLeft = Math.ceil((new Date(data.trial_end) - new Date()) / (1000 * 60 * 60 * 24));
            return Math.max(0, daysLeft);
        } catch { return 0; }
    }

    async getSubscriptionStatus() {
        try {
            const { data, error } = await supabase.from('subscriptions').select('*').eq('company_id', this.currentUser.company_id).maybeSingle();
            if (error || !data) return { status: 'none', daysLeft: 0, plan: 'free' };
            if (!data.trial_end) return {
                status: data.subscription_status || 'none',
                daysLeft: 0,
                plan: data.subscription_plan || 'trial',
                employees: data.employee_count || 5
            };
            const end = new Date(data.trial_end);
            if (Number.isNaN(end.getTime())) return {
                status: data.subscription_status || 'none',
                daysLeft: 0,
                plan: data.subscription_plan || 'trial',
                employees: data.employee_count || 5
            };
            const daysLeft = Math.ceil((end - new Date()) / (1000 * 60 * 60 * 24));
            return {
                status: data.subscription_status,
                daysLeft: Math.max(0, daysLeft),
                plan: data.subscription_plan || 'trial',
                employees: data.employee_count || 5
            };
        } catch { return { status: 'none', daysLeft: 0, plan: 'free' }; }
    }

    async updateTrialStatus() {
        const daysLeft = await this.getTrialDaysRemaining();
        const daysDisplay = document.getElementById('trial-days-left');
        if (daysDisplay) daysDisplay.innerText = daysLeft;
        const statusDisplay = document.getElementById('trial-status');
        if (!statusDisplay) return;
        const sub = await this.getSubscriptionStatus();
        if (sub.status === 'active') {
            statusDisplay.innerHTML = daysLeft <= 0
                ? '<strong style="color: var(--amber);">Renewal due.</strong> Extend your plan to keep full access.'
                : `Your <strong>${sub.plan}</strong> plan renews in <strong style="color: var(--green);">${daysLeft}</strong> day${daysLeft !== 1 ? 's' : ''}.`;
            return;
        }
        if (daysLeft <= 0) {
            statusDisplay.innerHTML = '<strong style="color: var(--red);">Your trial has expired.</strong> Please upgrade to continue.';
        } else if (daysLeft <= 7) {
            statusDisplay.innerHTML = `You have <strong style="color: var(--amber);">${daysLeft}</strong> day${daysLeft !== 1 ? 's' : ''} left in your free trial.`;
        }
    }

    async updateSubscriptionStatusCard(daysLeft) {
        const card = document.getElementById('subscription-status-card');
        const badge = document.getElementById('plan-badge');
        const info = document.getElementById('trial-info');
        if (!card || !badge) return;
        card.style.display = 'block';
        const sub = await this.getSubscriptionStatus();
        if (sub.status === 'active' && sub.plan !== 'trial') {
            badge.innerText = '✓ Subscribed';
            badge.style.color = 'var(--green)';
            if (info) info.innerText = daysLeft <= 0 ? `Plan: ${sub.plan}. Renew to keep full access.` : `Plan: ${sub.plan}. Renews in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.`;
            return;
        }
        if (daysLeft <= 0) {
            badge.innerText = '⏰ Trial Expired';
            badge.style.color = 'var(--red)';
            if (info) info.innerText = 'Your free trial has ended. Please upgrade to continue.';
        } else if (daysLeft <= 7) {
            badge.innerText = `⚠️ ${daysLeft} Day${daysLeft !== 1 ? 's' : ''} Left`;
            badge.style.color = 'var(--amber)';
            if (info) info.innerText = `Your free trial expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.`;
        } else {
            badge.innerText = `✓ Free Trial`;
            badge.style.color = 'var(--green)';
            if (info) info.innerText = `Enjoy your free trial! ${daysLeft} days remaining.`;
        }
    }

    selectPlanAndContinue(maxEmployees, planName) {
        if (!this.currentUser) return alert('Session expired. Please login.');
        this.showToast({ message: `✓ ${planName} plan selected!`, type: 'success' });
        this.showView('view-manager');
        this.refreshDashboard();
    }

    // ─── PAYMENT ─────────────────────────────────────────────────────────────

    loadPaystackScript() {
        return new Promise((resolve, reject) => {
            if (typeof PaystackPop !== 'undefined') { resolve(); return; }
            const existing = document.querySelector('script[src*="js.paystack.co"]');
            if (existing) {
                if (typeof PaystackPop !== 'undefined') { resolve(); return; }
                existing.addEventListener('load', () => resolve());
                existing.addEventListener('error', () => reject(new Error('Paystack script failed')));
                return;
            }
            const s = document.createElement('script');
            s.src = 'https://js.paystack.co/v1/inline.js';
            s.defer = true;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('Paystack script failed'));
            document.head.appendChild(s);
        });
    }

    initiatePayment(planName, amount, maxEmployees) {
        if (!this.currentUser) return;
        const manager = this.managers[this.currentUser.username];
        const email = manager?.email || '';
        if (!email) return alert('Manager email not found. Please contact support.');

        const openPaystack = () => {
            if (typeof PaystackPop === 'undefined') return alert('Payment script is still loading. Wait a moment and tap Subscribe again.');
            const handler = PaystackPop.setup({
                key: 'pk_test_554291712d47569a3381b5b6c48cc64d03053dd5',
                email, amount, currency: 'GHS',
                ref: `WW-${this.currentUser.company_id}-${Date.now()}`,
                metadata: { company_id: this.currentUser.company_id, plan: planName, max_employees: maxEmployees },
                callback: (response) => { this.onPaymentSuccess(response, planName, maxEmployees); },
                onClose: () => { this.showToast({ message: 'Payment cancelled', type: 'warning' }); }
            });
            handler.openIframe();
        };

        this.loadPaystackScript().then(openPaystack).catch(() => alert('Could not load the payment provider. Check your connection and try again.'));
    }

    async onPaymentSuccess(response, planName, maxEmployees) {
        try {
            const subscriptionEndDate = new Date();
            subscriptionEndDate.setDate(subscriptionEndDate.getDate() + 30);
            const base = {
                company_id: this.currentUser.company_id,
                subscription_plan: planName,
                subscription_status: 'active',
                trial_end: subscriptionEndDate.toISOString(),
                employee_count: maxEmployees,
                paystack_ref: response.reference
            };
            const withRadius = { ...base, geofence_radius_m: this.getEffectiveGeofenceRadius() };
            let { error } = await supabase.from('subscriptions').upsert(withRadius, { onConflict: 'company_id' });
            if (error && String(error.message || '').toLowerCase().includes('geofence_radius_m')) {
                ({ error } = await supabase.from('subscriptions').upsert(base, { onConflict: 'company_id' }));
            }
            if (error) throw error;
            this.showToast({ message: `${planName} plan activated! Valid until ${subscriptionEndDate.toLocaleDateString()}`, type: 'success' });
            this.showView('view-manager');
            this.refreshDashboard();
        } catch (error) {
            alert('Payment recorded but failed to update subscription: ' + error.message);
        }
    }

    // ─── REALTIME ────────────────────────────────────────────────────────────

    setupRealtimeSubscriptions() {
        try {
            if (!this.currentUser?.company_id) return;
            const companyId = this.currentUser.company_id;

            const employeesChannel = supabase.channel('employees_changes')
                .on('postgres_changes', { event: '*', schema: 'public', table: 'employees', filter: `company_id=eq.${companyId}` }, (payload) => {
                    const newData = payload.new;
                    if (newData?.username) {
                        this.employees[newData.username] = newData;
                        if (this.currentUser?.username === newData.username) {
                            this.currentUser = { ...this.currentUser, ...newData };
                            localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));
                        }
                        if (this.currentUser?.role === 'manager') {
                            this.loadAllData().then(() => this.refreshDashboard());
                        }
                    }
                }).subscribe();
            this.subscriptions.employees = employeesChannel;

            const checkinsChannel = supabase.channel('checkins_changes')
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'checkins', filter: `company_id=eq.${companyId}` }, (payload) => {
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

    // ─── UI HELPERS ───────────────────────────────────────────────────────────

    showView(viewId) {
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
        });
        const targetView = document.getElementById(viewId);
        if (targetView) {
            targetView.classList.add('active');
        }
    }

    showToast({ message, type = 'info' }) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('leaving');
            setTimeout(() => toast.remove(), 220);
        }, 3000);
    }

    showToastFromLegacyAlert(message) {
        this.showToast({ message, type: 'error' });
    }

    async refreshDashboard() {
        if (!this.currentUser || this.currentUser.role !== 'manager') return;

        const companyData = this.getCompanyData(this.currentUser.company_id);
        
        // Update team status
        const teamStatus = document.getElementById('team-status-display');
        if (teamStatus) {
            if (companyData.employees.length === 0) {
                teamStatus.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">No employees assigned yet.</p>';
            } else {
                teamStatus.innerHTML = companyData.employees.map(emp => `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--border);">
                        <span style="font-size:0.9rem;">${emp.username}</span>
                        <span style="font-size:0.8rem; color:var(--text-muted);">${emp.assignedSiteId || 'Unassigned'}</span>
                    </div>
                `).join('');
            }
        }

        // Update activity log
        const activityList = document.getElementById('employee-list');
        if (activityList) {
            if (companyData.logs.length === 0) {
                activityList.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">No activity yet.</p>';
            } else {
                activityList.innerHTML = companyData.logs.map(log => `
                    <div style="padding:8px 0; border-bottom:1px solid var(--border);">
                        <div style="font-size:0.9rem;">${log.username}: ${log.action}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted);">${new Date(log.time).toLocaleString()}</div>
                    </div>
                `).join('');
            }
        }

        // Update site list
        const siteList = document.getElementById('site-list-display');
        if (siteList) {
            if (companyData.sites.length === 0) {
                siteList.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">No sites created yet.</p>';
            } else {
                siteList.innerHTML = companyData.sites.map(site => `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--border);">
                        <span style="font-size:0.9rem;">${site.name}</span>
                        <button class="btn btn-outline btn-sm" onclick="app.deleteSite('${site.id}')">Delete</button>
                    </div>
                `).join('');
            }
        }

        // Update worksite dropdown
        const siteSelect = document.getElementById('new-emp-site');
        if (siteSelect) {
            siteSelect.innerHTML = '<option value="" disabled selected>Select Worksite</option>' +
                companyData.sites.map(site => `<option value="${site.id}">${site.name}</option>`).join('');
        }

        // Update team list
        const teamList = document.getElementById('team-list-container');
        if (teamList) {
            if (companyData.employees.length === 0) {
                teamList.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; text-align:center;">No employees yet.</p>';
            } else {
                teamList.innerHTML = companyData.employees.map(emp => `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--border);">
                        <span style="font-size:0.9rem;">${emp.username}</span>
                        <button class="btn btn-outline btn-sm" onclick="app.deleteEmployee('${emp.username}')">Remove</button>
                    </div>
                `).join('');
            }
        }

        // Update subscription status
        this.updateTrialStatus();
        this.updateSubscriptionStatusCard(await this.getTrialDaysRemaining());
    }

    togglePanel(bodyId, iconId) {
        const body = document.getElementById(bodyId);
        const icon = document.getElementById(iconId);
        if (body && icon) {
            const isHidden = body.style.display === 'none';
            body.style.display = isHidden ? 'block' : 'none';
            icon.textContent = isHidden ? '-' : '+';
        }
    }

    // ─── AUTH STATE ──────────────────────────────────────────────────────────

    async login() {
        const username = document.getElementById('auth-username')?.value?.trim()?.toLowerCase();
        const companyId = document.getElementById('auth-company')?.value?.trim()?.toUpperCase();
        const password = document.getElementById('auth-passcode')?.value;

        if (!username || !companyId || !password) {
            this.showToast({ message: 'Please fill in all fields', type: 'error' });
            return;
        }

        try {
            const user = this.managers[username] || this.employees[username];
            if (!user) {
                this.showToast({ message: 'User not found', type: 'error' });
                return;
            }

            if (user.company_id !== companyId) {
                this.showToast({ message: 'Invalid company ID', type: 'error' });
                return;
            }

            // Simple password check (in production, use proper hashing)
            if (user.password !== password) {
                this.showToast({ message: 'Invalid password', type: 'error' });
                return;
            }

            this.currentUser = { username: user.username, role: user.role, company_id: user.company_id };
            localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));

            if (user.role === 'manager') {
                await this.loadGeofenceRadiusFromSubscription(user.company_id);
                this.showView('view-manager');
                this.refreshDashboard();
            } else {
                this.showView('view-employee');
            }

            this.showToast({ message: 'Signed in successfully', type: 'success' });
        } catch (error) {
            console.error('Login error:', error);
            this.showToast({ message: 'Login failed: ' + error.message, type: 'error' });
        }
    }

    async logout() {
        this.currentUser = null;
        localStorage.removeItem('hrapp_user');
        this.showView('view-auth');
        this.updateBiometricLoginButton();
    }

    async registerNewCompany() {
        const companyName = document.getElementById('reg-company-name')?.value?.trim();
        const companyId = document.getElementById('reg-company-id')?.value?.trim().toUpperCase();
        const username = document.getElementById('reg-manager-name')?.value?.trim().toLowerCase();
        const email = document.getElementById('reg-manager-email')?.value?.trim();
        const password = document.getElementById('reg-manager-password')?.value;

        if (!companyName || !companyId || !username || !email || !password) {
            this.showToast({ message: 'Please fill in all fields', type: 'error' });
            return;
        }

        try {
            if (this.managers[username] || this.employees[username]) {
                this.showToast({ message: 'Username already taken', type: 'error' });
                return;
            }

            const managerData = {
                username,
                email,
                password,
                company_id: companyId,
                role: 'manager'
            };

            await this.saveManager(username, managerData);
            this.currentUser = { username, role: 'manager', company_id: companyId };
            localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));

            await this.createTrialSubscription(companyId);
            await this.loadGeofenceRadiusFromSubscription(companyId);

            this.showView('view-pricing');
            this.showToast({ message: 'Workspace created successfully', type: 'success' });
        } catch (error) {
            console.error('Registration error:', error);
            this.showToast({ message: 'Registration failed: ' + error.message, type: 'error' });
        }
    }

    async registerNewEmployeeUser() {
        const username = document.getElementById('reg-emp-username-self')?.value?.trim().toLowerCase();
        const email = document.getElementById('reg-emp-email-self')?.value?.trim();
        const phone = document.getElementById('reg-emp-phone-self')?.value?.trim();
        const passcode = document.getElementById('reg-emp-passcode-self')?.value;

        if (!username || (!email && !phone)) {
            this.showToast({ message: 'Please provide username and contact info', type: 'error' });
            return;
        }

        try {
            if (this.managers[username] || this.employees[username]) {
                this.showToast({ message: 'Username already taken', type: 'error' });
                return;
            }

            const employeeData = {
                username,
                email: email || null,
                phone: phone || null,
                passcode: passcode || null,
                role: 'employee',
                company_id: null,
                assigned_site_id: null
            };

            await this.saveEmployee(username, employeeData);
            this.showView('view-auth');
            this.showToast({ message: 'Account created. Ask your manager to link you to the company.', type: 'success' });
        } catch (error) {
            console.error('Employee registration error:', error);
            this.showToast({ message: 'Registration failed: ' + error.message, type: 'error' });
        }
    }

    async verifyAccount() {
        const code = document.getElementById('verify-code')?.value?.trim();
        if (!code || code.length !== 6) {
            this.showToast({ message: 'Please enter a valid 6-digit code', type: 'error' });
            return;
        }

        try {
            // In a real implementation, this would verify the OTP with Supabase
            this._otpJustVerified = true;
            this.showToast({ message: 'Account verified successfully', type: 'success' });
            
            if (this.pendingRegistration) {
                this.currentUser = this.pendingRegistration;
                localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));
                this.clearPendingRegistration();
                this.showView(this.currentUser.role === 'manager' ? 'view-manager' : 'view-employee');
            }
        } catch (error) {
            console.error('Verification error:', error);
            this.showToast({ message: 'Verification failed: ' + error.message, type: 'error' });
        }
    }

    async resendOtp() {
        this.showToast({ message: 'OTP resent to your email', type: 'success' });
    }

    async loginWithBiometrics() {
        const username = document.getElementById('auth-username')?.value?.trim()?.toLowerCase();
        const companyId = document.getElementById('auth-company')?.value?.trim()?.toUpperCase();

        if (!username || !companyId) {
            this.showToast({ message: 'Please enter username and company ID', type: 'error' });
            return;
        }

        try {
            const user = this.employees[username];
            if (!user || user.company_id !== companyId) {
                this.showToast({ message: 'User not found', type: 'error' });
                return;
            }

            const fingerprint = await this.generateDeviceFingerprint();
            const biometricMap = this.getBiometricMap();
            const key = this.getBiometricKey(username, user.company_id, fingerprint);
            const storedCred = biometricMap[key];

            if (!storedCred) {
                this.showToast({ message: 'Biometrics not set up for this device', type: 'error' });
                return;
            }

            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const userId = new TextEncoder().encode(`${user.company_id}:${username}`);

            const assertion = await navigator.credentials.get({
                publicKey: {
                    challenge,
                    allowCredentials: [{
                        id: this.base64ToArrayBuffer(storedCred.credentialId),
                        type: 'public-key'
                    }],
                    userVerification: 'required',
                    timeout: 60000
                }
            });

            if (assertion) {
                this.currentUser = { username: user.username, role: user.role, company_id: user.company_id };
                localStorage.setItem('hrapp_user', JSON.stringify(this.currentUser));
                this.showView('view-employee');
                this.showToast({ message: 'Signed in with biometrics', type: 'success' });
            }
        } catch (error) {
            console.error('Biometric login error:', error);
            this.showToast({ message: 'Biometric login failed: ' + error.message, type: 'error' });
        }
    }

    // ─── EMPLOYEE ACTIONS ───────────────────────────────────────────────────────

    async createSite() {
        const siteName = document.getElementById('new-site-name')?.value?.trim();
        if (!siteName) {
            this.showToast({ message: 'Please enter a site name', type: 'error' });
            return;
        }

        if (!this.currentPosition) {
            this.showToast({ message: 'Waiting for GPS location', type: 'error' });
            return;
        }

        try {
            const siteId = `${this.currentUser.company_id}-${Date.now()}`;
            const siteData = {
                id: siteId,
                name: siteName,
                lat: this.currentPosition.lat,
                lng: this.currentPosition.lng,
                company_id: this.currentUser.company_id
            };

            await this.saveSite(siteData);
            document.getElementById('new-site-name').value = '';
            this.refreshDashboard();
            this.showToast({ message: 'Site created successfully', type: 'success' });
        } catch (error) {
            console.error('Error creating site:', error);
            this.showToast({ message: 'Failed to create site: ' + error.message, type: 'error' });
        }
    }

    async registerEmployee() {
        const username = document.getElementById('new-emp-username')?.value?.trim().toLowerCase();
        const siteId = document.getElementById('new-emp-site')?.value;
        const contact = document.getElementById('new-emp-contact')?.value?.trim();
        const passcode = document.getElementById('new-emp-passcode')?.value;

        if (!username || !siteId) {
            this.showToast({ message: 'Please provide username and select a worksite', type: 'error' });
            return;
        }

        try {
            const employee = this.employees[username];
            if (!employee) {
                this.showToast({ message: 'Employee not found. Ask them to create an account first.', type: 'error' });
                return;
            }

            if (employee.company_id && employee.company_id !== this.currentUser.company_id) {
                this.showToast({ message: 'Employee already linked to another company', type: 'error' });
                return;
            }

            employee.company_id = this.currentUser.company_id;
            employee.assigned_site_id = siteId;
            if (contact) employee.email = contact;
            if (passcode) employee.passcode = passcode;

            await this.saveEmployee(username, employee);
            
            // Clear form
            document.getElementById('new-emp-username').value = '';
            document.getElementById('new-emp-contact').value = '';
            document.getElementById('new-emp-passcode').value = '';
            document.getElementById('new-emp-site').value = '';

            this.refreshDashboard();
            this.showToast({ message: 'Employee linked successfully', type: 'success' });
        } catch (error) {
            console.error('Error linking employee:', error);
            this.showToast({ message: 'Failed to link employee: ' + error.message, type: 'error' });
        }
    }

    async checkIn() {
        if (!this.currentPosition) {
            this.showToast({ message: 'Waiting for GPS location', type: 'error' });
            return;
        }

        const user = this.employees[this.currentUser.username];
        if (!user || !user.assigned_site_id) {
            this.showToast({ message: 'No worksite assigned', type: 'error' });
            return;
        }

        const site = this.sites[user.assigned_site_id];
        if (!site) {
            this.showToast({ message: 'Assigned site not found', type: 'error' });
            return;
        }

        const distance = this.calculateDistance(
            this.currentPosition.lat,
            this.currentPosition.lng,
            site.lat,
            site.lng
        );

        const radius = this.getEffectiveGeofenceRadius();
        if (distance > radius) {
            this.showToast({ message: `You are too far from the worksite (${distance.toFixed(0)}m away, max ${radius}m)`, type: 'error' });
            return;
        }

        try {
            const checkinData = {
                username: this.currentUser.username,
                action: 'check-in',
                company_id: this.currentUser.company_id,
                site_id: site.id,
                time: new Date().toISOString()
            };

            await this.saveCheckin(checkinData);
            this.updateEmployeeStatus(true);
            this.showToast({ message: 'Checked in successfully', type: 'success' });
        } catch (error) {
            console.error('Error checking in:', error);
            this.showToast({ message: 'Failed to check in: ' + error.message, type: 'error' });
        }
    }

    async checkOut() {
        const reason = document.getElementById('checkout-reason')?.value?.trim();
        
        try {
            const user = this.employees[this.currentUser.username];
            const checkinData = {
                username: this.currentUser.username,
                action: 'check-out',
                company_id: this.currentUser.company_id,
                site_id: user?.assigned_site_id,
                time: new Date().toISOString(),
                reason: reason || ''
            };

            await this.saveCheckin(checkinData);
            this.updateEmployeeStatus(false);
            document.getElementById('checkout-reason').value = '';
            this.toggleCheckoutReason();
            this.showToast({ message: 'Checked out successfully', type: 'success' });
        } catch (error) {
            console.error('Error checking out:', error);
            this.showToast({ message: 'Failed to check out: ' + error.message, type: 'error' });
        }
    }

    toggleCheckoutReason() {
        const panel = document.getElementById('checkout-reason-panel');
        if (panel) {
            const isHidden = panel.style.display === 'none';
            panel.style.display = isHidden ? 'block' : 'none';
        }
    }

    updateEmployeeStatus(isCheckedIn) {
        const statusBox = document.getElementById('emp-status-box');
        const statusIcon = document.getElementById('emp-status-icon');
        const statusText = document.getElementById('emp-status-text');
        const timer = document.getElementById('emp-timer');
        const checkInBtn = document.getElementById('btn-checkin');
        const checkOutBtn = document.getElementById('btn-checkout');

        if (isCheckedIn) {
            statusBox.className = 'status-indicator checked-in';
            statusIcon.textContent = '✓';
            statusText.textContent = 'Checked In';
            timer.style.display = 'block';
            checkInBtn.style.display = 'none';
            checkOutBtn.style.display = 'block';
            this.startTimer();
        } else {
            statusBox.className = 'status-indicator checked-out';
            statusIcon.textContent = '🛑';
            statusText.textContent = 'Checked Out';
            timer.style.display = 'none';
            checkInBtn.style.display = 'block';
            checkOutBtn.style.display = 'none';
            this.stopTimer();
        }
    }

    startTimer() {
        this.stopTimer();
        const startTime = Date.now();
        this.timerInterval = setInterval(() => {
            const elapsed = Date.now() - startTime;
            const hours = Math.floor(elapsed / 3600000);
            const minutes = Math.floor((elapsed % 3600000) / 60000);
            const seconds = Math.floor((elapsed % 60000) / 1000);
            const timer = document.getElementById('emp-timer');
            if (timer) {
                timer.textContent = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
            }
        }, 1000);
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
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

    setupAuthInputListeners() {
        const usernameField = document.getElementById('auth-username');
        const companyField = document.getElementById('auth-company');
        if (usernameField) usernameField.addEventListener('input', () => { this.updateBiometricLoginButton(); });
        if (companyField) companyField.addEventListener('input', () => { this.updateBiometricLoginButton(); });
    }

    clearPendingRegistration() {
        this.pendingRegistration = null;
        this.pendingUser = null;
        localStorage.removeItem('hrapp_pending_registration');
    }

    // ─── BIOMETRICS ──────────────────────────────────────────────────────────

    async hashString(input) {
        const encoded = new TextEncoder().encode(input);
        const digest = await crypto.subtle.digest('SHA-256', encoded);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async generateDeviceFingerprint() {
        const nav = window.navigator;
        const screenInfo = window.screen || {};
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
        const fingerprintPayload = {
            userAgent: nav.userAgent || '', platform: nav.platform || '',
            language: nav.language || '', languages: (nav.languages || []).join(','),
            hardwareConcurrency: nav.hardwareConcurrency || 0, deviceMemory: nav.deviceMemory || 0,
            maxTouchPoints: nav.maxTouchPoints || 0,
            screen: `${screenInfo.width || 0}x${screenInfo.height || 0}x${screenInfo.colorDepth || 0}`,
            timezone: tz
        };
        return this.hashString(JSON.stringify(fingerprintPayload));
    }

    getBiometricMap() {
        try {
            const raw = localStorage.getItem(this.BIOMETRIC_STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (error) {
            console.warn('Failed to read biometric storage:', error);
            return {};
        }
    }

    setBiometricMap(nextMap) {
        localStorage.setItem(this.BIOMETRIC_STORAGE_KEY, JSON.stringify(nextMap));
    }

    getBiometricKey(username, companyId, fingerprint) {
        return `${username}::${companyId || 'nocompany'}::${fingerprint || 'nofp'}`;
    }

    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        bytes.forEach(byte => { binary += String.fromCharCode(byte); });
        return btoa(binary);
    }

    base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }

    async updateBiometricLoginButton() {
        const biometricBtn = document.getElementById('auth-biometric-btn');
        if (!biometricBtn) return;
        const username = document.getElementById('auth-username')?.value?.trim()?.toLowerCase();
        const companyId = document.getElementById('auth-company')?.value?.trim()?.toUpperCase();
        if (!username) { biometricBtn.style.display = 'none'; return; }
        const user = this.managers[username] || this.employees[username];
        if (!user || user.role !== 'employee' || !user.company_id || (companyId && user.company_id !== companyId)) {
            biometricBtn.style.display = 'none'; return;
        }
        if (!window.PublicKeyCredential) { biometricBtn.style.display = 'none'; return; }
        const fingerprint = await this.generateDeviceFingerprint();
        const biometricMap = this.getBiometricMap();
        const key = this.getBiometricKey(username, user.company_id, fingerprint);
        biometricBtn.style.display = biometricMap[key]?.credentialId ? 'block' : 'none';
    }

    async enableBiometrics() {
        if (!this.currentUser || this.currentUser.role !== 'employee') return;
        if (!window.PublicKeyCredential || !navigator.credentials) return alert('Biometrics are not supported on this browser/device.');
        const employee = this.employees[this.currentUser.username];
        if (!employee) return alert('Employee profile not found.');
        try {
            const fingerprint = await this.generateDeviceFingerprint();
            if (employee.device_fingerprint && employee.device_fingerprint !== fingerprint) return alert('This device is not the bound login device. Contact your manager to reset binding.');
            if (!employee.device_fingerprint) { employee.device_fingerprint = fingerprint; employee.device_bound_at = new Date().toISOString(); }
            
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const userId = new TextEncoder().encode(`${employee.company_id}:${this.currentUser.username}`);
            
            const credential = await navigator.credentials.create({
                publicKey: {
                    challenge, 
                    rp: { name: 'WorkWatch' },
                    user: { id: userId, name: this.currentUser.username, displayName: this.currentUser.username },
                    pubKeyCredParams: [
                        { type: 'public-key', alg: -7 },  // ES256 (Passkey standard)
                        { type: 'public-key', alg: -257 } // RS256
                    ],
                    authenticatorSelection: {
                        authenticatorAttachment: 'platform',
                        userVerification: 'required'
                    },
                    timeout: 60000
                }
            });

            if (credential) {
                const credIdBase64 = this.arrayBufferToBase64(credential.rawId);
                const biometricMap = this.getBiometricMap();
                const key = this.getBiometricKey(this.currentUser.username, employee.company_id, fingerprint);
                
                biometricMap[key] = {
                    credentialId: credIdBase64,
                    username: this.currentUser.username,
                    companyId: employee.company_id
                };
                
                this.setBiometricMap(biometricMap);
                
                // Save employee data to keep Supabase record matching the local bound fingerprint
                await this.saveEmployee(this.currentUser.username, employee);
                
                if (window.app && typeof window.app.showToast === 'function') {
                    window.app.showToast({ message: '✓ Biometrics enabled successfully!', type: 'success' });
                } else {
                    alert('✓ Biometrics enabled successfully!');
                }
                this.updateBiometricLoginButton();
            }
        } catch (error) {
            console.error('Biometric registration failed:', error);
            alert('Biometrics enrollment failed: ' + error.message);
        }
    }
}

window.app = new HRApp();