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

    // ─── AUTH STATE ──────────────────────────────────────────────────────────

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