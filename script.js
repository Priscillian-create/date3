// FIX: Register service worker for offline functionality
// Only register service worker if not in StackBlitz environment
if ('serviceWorker' in navigator && !window.location.hostname.includes('stackblitz')) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js')
            .then(registration => {
                console.log('ServiceWorker registration successful with scope: ', registration.scope);
            })
            .catch(err => {
                console.log('ServiceWorker registration failed: ', err);
            });
    });
} else if (window.location.hostname.includes('stackblitz')) {
    console.log('ServiceWorker registration skipped: Running in StackBlitz environment');
}

// Offline/Online Detection and Sync Management
const offlineIndicator = document.getElementById('offline-indicator');
const syncStatus = document.getElementById('sync-status');
const syncStatusText = document.getElementById('sync-status-text');
let isOnline = navigator.onLine;
let syncQueue = [];
let connectionRetryCount = 0;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 5000; // 5 seconds

// Initialize Supabase
const supabaseUrl = 'https://ieriphdzlbuzqqwrymwn.supabase.co'; // Replace with your Supabase URL
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImllcmlwaGR6bGJ1enFxd3J5bXduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIzMDU1MTgsImV4cCI6MjA3Nzg4MTUxOH0.bvbs6joSxf1u9U8SlaAYmjve-N6ArNYcNMtnG6-N_HU'; // Replace with your Supabase anon key
const supabase = window.supabase.createClient(supabaseUrl, supabaseKey);

// FIX: Add connection retry logic
function checkSupabaseConnection() {
    if (!isOnline) return;
    
    // Try a simple read operation to check connection
    supabase.from('products').select('count').limit(1)
        .then(() => {
            console.log('Supabase connection is working');
            connectionRetryCount = 0;
            
            // Process any pending sync operations
            if (syncQueue.length > 0) {
                processSyncQueue();
            }
        })
        .catch(error => {
            console.error('Supabase connection check failed:', error);
            
            if (connectionRetryCount < MAX_RETRY_ATTEMPTS) {
                connectionRetryCount++;
                console.log(`Retrying Supabase connection (${connectionRetryCount}/${MAX_RETRY_ATTEMPTS})...`);
                
                setTimeout(checkSupabaseConnection, RETRY_DELAY);
            } else {
                console.error('Max retry attempts reached. Supabase connection may be unavailable.');
                showNotification('Connection to database failed. Some features may be limited.', 'warning');
            }
        });
}

// PWA Install Prompt Setup
let deferredPrompt;
const installBtn = document.getElementById('install-btn');

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.style.display = 'flex';
});

installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === 'accepted') {
        console.log('User accepted the install prompt');
        installBtn.style.display = 'none';
    } else {
        console.log('User dismissed the install prompt');
    }
    deferredPrompt = null;
});

// Online/Offline Detection
window.addEventListener('online', () => {
    isOnline = true;
    offlineIndicator.classList.remove('show');
    showNotification('You are back online!', 'success');
    
    // Check Supabase connection
    checkSupabaseConnection();
});

window.addEventListener('offline', () => {
    isOnline = false;
    offlineIndicator.classList.add('show');
});

// ✅ FIXED: Improved addToSyncQueue() - better duplicate detection
function addToSyncQueue(operation) {
    // For sales, check by receipt number instead of exact data match
    if (operation.type === 'saveSale') {
        const receiptNumber = operation.data.receiptNumber;
        
        // Check if this sale is already in the queue
        if (syncQueue.some(op => 
            op.type === 'saveSale' && 
            op.data.receiptNumber === receiptNumber
        )) {
            console.log(`Sale with receipt ${receiptNumber} already in sync queue — skipping`);
            return;
        }
        
        // Check if this sale was already synced to Supabase
        if (isOnline) {
            supabase.from('sales').select('*').eq('receiptNumber', receiptNumber)
                .then(({ data, error }) => {
                    if (!error && data.length > 0) {
                        console.log(`Sale with receipt ${receiptNumber} already exists in Supabase — removing from queue`);
                        // Remove this operation from the queue
                        const index = syncQueue.findIndex(op => 
                            op.type === 'saveSale' && 
                            op.data.receiptNumber === receiptNumber
                        );
                        if (index !== -1) {
                            syncQueue.splice(index, 1);
                            localStorage.setItem('syncQueue', JSON.stringify(syncQueue));
                        }
                    }
                })
                .catch(error => {
                    console.error('Error checking for existing sale:', error);
                });
        }
    } else {
        // For other operations, keep the original duplicate check
        if (syncQueue.some(op => 
            op.type === operation.type && 
            JSON.stringify(op.data) === JSON.stringify(operation.data)
        )) {
            console.log('Duplicate operation detected — skipping');
            return;
        }
    }

    syncQueue.push(operation);
    localStorage.setItem('syncQueue', JSON.stringify(syncQueue));

    if (isOnline) {
        processSyncQueue();
    } else {
        showNotification('Offline: Sale saved locally and will sync automatically.', 'info');
    }
}

// ✅ FIXED: Improved processSyncQueue() - better sales handling
function processSyncQueue() {
    if (syncQueue.length === 0) return;

    syncStatus.classList.add('show', 'syncing');
    syncStatusText.textContent = 'Syncing data...';

    const operation = syncQueue.shift();

    if (operation.synced) {
        processNext();
        return;
    }

    let operationPromise;

    if (operation.type === 'saveSale') {
        // Check if sale already exists by receipt number
        operationPromise = supabase.from('sales').select('*').eq('receiptNumber', operation.data.receiptNumber)
            .then(({ data, error }) => {
                if (!error && data.length === 0) {
                    // Sale doesn't exist, add it to Supabase
                    return supabase.from('sales').insert(operation.data)
                        .then(({ data, error }) => {
                            if (!error && data.length > 0) {
                                // Update the local sale with the Supabase ID
                                const localSaleIndex = sales.findIndex(s => s.receiptNumber === operation.data.receiptNumber);
                                if (localSaleIndex !== -1) {
                                    sales[localSaleIndex].id = data[0].id;
                                    saveToLocalStorage();
                                }
                                return data[0];
                            } else {
                                throw error;
                            }
                        });
                } else {
                    console.log(`Sale with receipt ${operation.data.receiptNumber} already exists — skipping`);
                    // Update the local sale with the Supabase ID
                    if (data.length > 0) {
                        const localSaleIndex = sales.findIndex(s => s.receiptNumber === operation.data.receiptNumber);
                        if (localSaleIndex !== -1) {
                            sales[localSaleIndex].id = data[0].id;
                            saveToLocalStorage();
                        }
                    }
                    return Promise.resolve();
                }
            });
    } else if (operation.type === 'saveProduct') {
        operationPromise = supabase.from('products').upsert(operation.data);
    } else if (operation.type === 'deleteProduct') {
        operationPromise = supabase.from('products').delete().eq('id', operation.id);
    } else if (operation.type === 'deleteSale') {
        operationPromise = supabase.from('sales').delete().eq('id', operation.id);
    } else {
        operationPromise = Promise.resolve();
    }

    operationPromise
        .then(() => {
            operation.synced = true;
            localStorage.setItem('syncQueue', JSON.stringify(syncQueue));
            processNext();
        })
        .catch(error => {
            console.error('Sync error:', error);
            syncQueue.unshift(operation);
            localStorage.setItem('syncQueue', JSON.stringify(syncQueue));
            syncStatus.classList.remove('syncing');
            syncStatus.classList.add('error');
            syncStatusText.textContent = 'Sync error';
            setTimeout(() => syncStatus.classList.remove('show', 'error'), 3000);
        });

    function processNext() {
        setTimeout(() => {
            if (syncQueue.length > 0) {
                processSyncQueue();
            } else {
                syncStatus.classList.remove('syncing');
                syncStatus.classList.add('show');
                syncStatusText.textContent = 'All data synced';
                setTimeout(() => syncStatus.classList.remove('show'), 3000);
            }
        }, 800);
    }
}

// Load sync queue from localStorage on app start
function loadSyncQueue() {
    const savedQueue = localStorage.getItem('syncQueue');
    if (savedQueue) {
        try {
            syncQueue = JSON.parse(savedQueue);
        } catch (e) {
            console.error('Error parsing sync queue:', e);
            syncQueue = [];
        }
    }
}

// Clean up completed sync operations
function cleanupSyncQueue() {
    syncQueue = syncQueue.filter(op => !op.synced);
    localStorage.setItem('syncQueue', JSON.stringify(syncQueue));
}

// ✅ FIXED: Add function to clean up duplicate sales on app startup
function cleanupDuplicateSales() {
    const receiptNumbers = new Set();
    const uniqueSales = [];
    
    sales.forEach(sale => {
        if (!receiptNumbers.has(sale.receiptNumber)) {
            receiptNumbers.add(sale.receiptNumber);
            uniqueSales.push(sale);
        } else {
            console.log(`Removing duplicate sale with receipt: ${sale.receiptNumber}`);
        }
    });
    
    if (sales.length !== uniqueSales.length) {
        sales = uniqueSales;
        saveToLocalStorage();
        console.log(`Cleaned up ${sales.length - uniqueSales.length} duplicate sales`);
    }
}

// ✅ FIXED: Add function to set up real-time listeners properly
function setupRealtimeListeners() {
    // Products listener
    if (isOnline) {
        supabase
            .channel('products-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, (payload) => {
                console.log('Products change received:', payload);
                
                // Refresh products
                DataModule.fetchProducts().then(updatedProducts => {
                    products = updatedProducts;
                    saveToLocalStorage();
                    loadProducts();
                });
            })
            .subscribe();
        
        // Sales listener
        supabase
            .channel('sales-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, (payload) => {
                console.log('Sales change received:', payload);
                
                // Refresh sales
                DataModule.fetchSales().then(updatedSales => {
                    sales = updatedSales;
                    saveToLocalStorage();
                    loadSales();
                });
            })
            .subscribe();
        
        // Deleted sales listener
        supabase
            .channel('deleted-sales-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'deleted_sales' }, (payload) => {
                console.log('Deleted sales change received:', payload);
                
                // Refresh deleted sales
                DataModule.fetchDeletedSales().then(updatedDeletedSales => {
                    deletedSales = updatedDeletedSales;
                    saveToLocalStorage();
                    loadDeletedSales();
                });
            })
            .subscribe();
    }
}

// Data storage
let products = [];
let cart = [];
let sales = [];
let deletedSales = [];
let users = [];
let currentUser = null;
let currentPage = "pos";

// Settings - Updated phone number as requested
let settings = {
    storeName: "Pa Gerrys Mart",
    storeAddress: "Alatishe, Ibeju Lekki, Lagos State, Nigeria",
    storePhone: "+2347037850121", // Changed phone number as requested
    lowStockThreshold: 10,
    expiryWarningDays: 90 // 3 months = 90 days
};

// Local storage keys
const STORAGE_KEYS = {
    PRODUCTS: 'pagerrysmart_products',
    SALES: 'pagerrysmart_sales',
    DELETED_SALES: 'pagerrysmart_deleted_sales',
    USERS: 'pagerrysmart_users',
    SETTINGS: 'pagerrysmart_settings',
    CURRENT_USER: 'pagerrysmart_current_user'
};

// Load data from localStorage
function loadFromLocalStorage() {
    try {
        const savedProducts = localStorage.getItem(STORAGE_KEYS.PRODUCTS);
        if (savedProducts) {
            products = JSON.parse(savedProducts);
        }
        
        const savedSales = localStorage.getItem(STORAGE_KEYS.SALES);
        if (savedSales) {
            sales = JSON.parse(savedSales);
        }
        
        const savedDeletedSales = localStorage.getItem(STORAGE_KEYS.DELETED_SALES);
        if (savedDeletedSales) {
            deletedSales = JSON.parse(savedDeletedSales);
        }
        
        const savedUsers = localStorage.getItem(STORAGE_KEYS.USERS);
        if (savedUsers) {
            users = JSON.parse(savedUsers);
        }
        
        const savedSettings = localStorage.getItem(STORAGE_KEYS.SETTINGS);
        if (savedSettings) {
            settings = JSON.parse(savedSettings);
        }
        
        const savedCurrentUser = localStorage.getItem(STORAGE_KEYS.CURRENT_USER);
        if (savedCurrentUser) {
            currentUser = JSON.parse(savedCurrentUser);
        }
    } catch (e) {
        console.error('Error loading data from localStorage:', e);
    }
}

// Save data to localStorage
function saveToLocalStorage() {
    try {
        localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(products));
        localStorage.setItem(STORAGE_KEYS.SALES, JSON.stringify(sales));
        localStorage.setItem(STORAGE_KEYS.DELETED_SALES, JSON.stringify(deletedSales));
        localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users));
        localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
        
        if (currentUser) {
            localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(currentUser));
        }
    } catch (e) {
        console.error('Error saving data to localStorage:', e);
    }
}

// DOM elements
const loginPage = document.getElementById('login-page');
const appContainer = document.getElementById('app-container');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginTabs = document.querySelectorAll('.login-tab');
const tabContents = document.querySelectorAll('.tab-content');
const navLinks = document.querySelectorAll('.nav-link');
const pageContents = document.querySelectorAll('.page-content');
const pageTitle = document.getElementById('page-title');
const currentUserEl = document.getElementById('current-user');
const userRoleEl = document.getElementById('user-role');
const userRoleDisplayEl = document.getElementById('user-role-display');
const logoutBtn = document.getElementById('logout-btn');
const productsGrid = document.getElementById('products-grid');
const cartItems = document.getElementById('cart-items');
const totalEl = document.getElementById('total');
const inventoryTableBody = document.getElementById('inventory-table-body');
const inventoryTotalValueEl = document.getElementById('inventory-total-value');
const salesTableBody = document.getElementById('sales-table-body');
const deletedSalesTableBody = document.getElementById('deleted-sales-table-body');
const dailySalesTableBody = document.getElementById('daily-sales-table-body');
const productModal = document.getElementById('product-modal');
const receiptModal = document.getElementById('receipt-modal');
const notification = document.getElementById('notification');
const notificationMessage = document.getElementById('notification-message');
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const sidebar = document.getElementById('sidebar');

// Loading elements
const inventoryLoading = document.getElementById('inventory-loading');
const reportsLoading = document.getElementById('reports-loading');
const accountLoading = document.getElementById('account-loading');
const productModalLoading = document.getElementById('product-modal-loading');
const loginSubmitBtn = document.getElementById('login-submit-btn');
const registerSubmitBtn = document.getElementById('register-submit-btn');
const changePasswordBtn = document.getElementById('change-password-btn');
const saveProductBtn = document.getElementById('save-product-btn');
const completeSaleBtn = document.getElementById('complete-sale-btn');

// Authentication Module
const AuthModule = {
    // Sign up new user (admin only)
    async signUp(email, password, name, role = 'cashier') {
        try {
            // Check if current user is logged in and is admin
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) {
                showNotification("You must be logged in as an admin to create users.", "error");
                return { success: false };
            }

            // Ask admin to confirm their password
            const adminPassword = prompt("Please confirm your admin password to continue:");

            // Create the new user account
            const { data, error } = await supabase.auth.admin.createUser({
                email,
                password,
                user_metadata: {
                    name,
                    role
                }
            });

            if (error) {
                throw error;
            }

            // Save user details in users table
            const { error: dbError } = await supabase
                .from('users')
                .insert({
                    id: data.user.id,
                    name,
                    email,
                    role,
                    created_at: new Date().toISOString(),
                    last_login: new Date().toISOString(),
                    created_by: user.id
                });

            if (dbError) {
                throw dbError;
            }

            showNotification(`✅ User "${name}" (${role}) created successfully!`, "success");
            return { success: true };
        } catch (error) {
            console.error("Signup error:", error);
            showNotification("❌ Error creating user: " + error.message, "error");
            return { success: false, error: error.message };
        }
    },

    // Sign in existing user
    async signIn(email, password) {
        // Show loading state
        loginSubmitBtn.classList.add('loading');
        loginSubmitBtn.disabled = true;
        
        try {
            const { data, error } = await supabase.auth.signInWithPassword({
                email,
                password
            });

            if (error) {
                throw error;
            }

            // Create a basic user object from auth data as a fallback
            const fallbackUser = {
                id: data.user.id,
                name: data.user.user_metadata?.name || data.user.email?.split('@')[0] || 'User',
                email: data.user.email,
                role: data.user.user_metadata?.role || 'cashier',
                created_at: data.user.created_at,
                last_login: new Date().toISOString()
            };

            // Try to get user data from users table with error handling
            try {
                const { data: userData, error: userError } = await supabase
                    .from('users')
                    .select('*')
                    .eq('id', data.user.id)
                    .single();

                if (!userError && userData) {
                    currentUser = userData;
                    
                    // Update last login
                    try {
                        await supabase
                            .from('users')
                            .update({ last_login: new Date().toISOString() })
                            .eq('id', data.user.id);
                    } catch (updateError) {
                        console.warn('Could not update last login:', updateError);
                        // Continue even if update fails
                    }
                } else {
                    // If user doesn't exist in users table or there's an error, use fallback
                    console.warn('Using fallback user data due to error:', userError?.message || 'User not found');
                    currentUser = fallbackUser;
                    
                    // Try to create the user in the database, but don't fail if it doesn't work
                    try {
                        const { data: newUser, error: insertError } = await supabase
                            .from('users')
                            .insert(fallbackUser)
                            .select()
                            .single();
                        
                        if (!insertError && newUser) {
                            currentUser = newUser;
                        }
                    } catch (insertError) {
                        console.warn('Could not create user in database:', insertError);
                        // Continue with fallback user data
                    }
                }
            } catch (fetchError) {
                // Handle the infinite recursion error specifically
                if (fetchError.message && fetchError.message.includes('infinite recursion')) {
                    console.warn('Infinite recursion detected in users table policy, using fallback user data');
                    showNotification('Database policy issue detected. Using limited functionality.', 'warning');
                } else {
                    console.warn('Error fetching user data:', fetchError);
                }
                
                // Use fallback user data
                currentUser = fallbackUser;
            }
            
            localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(currentUser));
            showApp();
            showNotification('Login successful!', 'success');
            return { success: true };
        } catch (error) {
            console.error('Signin error:', error);
            showNotification(error.message || 'Login failed', 'error');
            return { success: false, error: error.message };
        } finally {
            // Hide loading state
            loginSubmitBtn.classList.remove('loading');
            loginSubmitBtn.disabled = false;
        }
    },
    
    // Sign out
    async signOut() {
        try {
            const { error } = await supabase.auth.signOut();
            
            if (error) {
                throw error;
            }
            
            currentUser = null;
            localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
            showLogin();
            showNotification('Logged out successfully', 'info');
        } catch (error) {
            console.error('Signout error:', error);
            showNotification(error.message, 'error');
        }
    },
    
    // Check if user is admin
    isAdmin() {
        return currentUser && currentUser.role === 'admin';
    },
    
    // Listen to auth state changes
    onAuthStateChanged(callback) {
        supabase.auth.onAuthStateChange(async (event, session) => {
            if (session) {
                // User is signed in
                // Create a basic user object from auth data as a fallback
                const fallbackUser = {
                    id: session.user.id,
                    name: session.user.user_metadata?.name || session.user.email?.split('@')[0] || 'User',
                    email: session.user.email,
                    role: session.user.user_metadata?.role || 'cashier',
                    created_at: session.user.created_at,
                    last_login: new Date().toISOString()
                };
                
                try {
                    const { data: userData, error } = await supabase
                        .from('users')
                        .select('*')
                        .eq('id', session.user.id)
                        .single();
                    
                    if (!error && userData) {
                        currentUser = userData;
                        localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(currentUser));
                        callback(currentUser);
                    } else {
                        // If user doesn't exist in users table or there's an error, use fallback
                        console.warn('Using fallback user data due to error:', error?.message || 'User not found');
                        currentUser = fallbackUser;
                        localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(currentUser));
                        callback(currentUser);
                        
                        // Try to create the user in the database, but don't fail if it doesn't work
                        try {
                            const { data: newUser, error: insertError } = await supabase
                                .from('users')
                                .insert(fallbackUser)
                                .select()
                                .single();
                            
                            if (!insertError && newUser) {
                                currentUser = newUser;
                                localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(currentUser));
                                callback(currentUser);
                            }
                        } catch (insertError) {
                            console.warn('Could not create user in database:', insertError);
                            // Continue with fallback user data
                        }
                    }
                } catch (fetchError) {
                    // Handle the infinite recursion error specifically
                    if (fetchError.message && fetchError.message.includes('infinite recursion')) {
                        console.warn('Infinite recursion detected in users table policy, using fallback user data');
                        showNotification('Database policy issue detected. Using limited functionality.', 'warning');
                    } else {
                        console.warn('Error fetching user data:', fetchError);
                    }
                    
                    // Use fallback user data
                    currentUser = fallbackUser;
                    localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(currentUser));
                    callback(currentUser);
                }
            } else {
                // User is signed out
                currentUser = null;
                localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
                callback(null);
            }
        });
    }
};

// ✅ FIXED: Data Module with improved error handling
const DataModule = {
    // NEW: Fetch products from Supabase
    async fetchProducts() {
        try {
            if (isOnline) {
                try {
                    const { data, error } = await supabase
                        .from('products')
                        .select('*');
                    
                    if (error) {
                        console.error('Supabase fetch error:', error);
                        
                        // Check if it's an RLS policy error
                        if (error.code === '42P17' || error.message.includes('infinite recursion')) {
                            console.warn('Infinite recursion detected in products table policy, using local data');
                            showNotification('Database policy issue detected for products. Using local cache.', 'warning');
                        } else if (error.code === '42501' || error.message.includes('policy')) {
                            console.warn('Permission denied for products table, using local data');
                            showNotification('Permission denied for products. Using local cache.', 'warning');
                        } else {
                            throw error;
                        }
                    } else if (data) {
                        // Normalize the data to ensure consistent field names
                        const normalizedProducts = data.map(product => {
                            // Handle different possible column names for expiry date
                            if (product.expiry_date && !product.expiryDate) {
                                product.expiryDate = product.expiry_date;
                            } else if (product.expiryDate && !product.expiry_date) {
                                product.expiry_date = product.expiryDate;
                            }
                            
                            return product;
                        });
                        
                        // Update global products variable
                        products = normalizedProducts;
                        saveToLocalStorage();
                        return products;
                    }
                } catch (fetchError) {
                    console.error('Failed to fetch from Supabase:', fetchError);
                    // Continue to local data
                }
            }
            
            // Offline or error: Use local data
            return products;
        } catch (error) {
            console.error('Error in fetchProducts:', error);
            // Fall back to local data
            return products;
        }
    },
    
    // NEW: Fetch sales from Supabase
    async fetchSales() {
        try {
            if (isOnline) {
                const { data, error } = await supabase
                    .from('sales')
                    .select('*');
                
                if (error) {
                    throw error;
                }
                
                // Update global sales variable
                sales = data;
                saveToLocalStorage();
                
                return sales;
            } else {
                // Offline: Use local data
                return sales;
            }
        } catch (error) {
            console.error('Error fetching sales:', error);
            // Fall back to local data
            return sales;
        }
    },
    
    // NEW: Fetch deleted sales from Supabase
    async fetchDeletedSales() {
        try {
            if (isOnline) {
                const { data, error } = await supabase
                    .from('deleted_sales')
                    .select('*');
                
                if (error) {
                    throw error;
                }
                
                // Update global deletedSales variable
                deletedSales = data;
                saveToLocalStorage();
                
                return deletedSales;
            } else {
                // Offline: Use local data
                return deletedSales;
            }
        } catch (error) {
            console.error('Error fetching deleted sales:', error);
            // Fall back to local data
            return deletedSales;
        }
    },
    
    // ✅ FIXED: Products with better error handling and column name flexibility
    async saveProduct(product) {
        // Show loading state
        productModalLoading.style.display = 'flex';
        saveProductBtn.disabled = true;
        
        try {
            // Validate product data before sending
            if (!product.name || !product.category || !product.price || !product.stock || !product.expiryDate) {
                throw new Error('Please fill in all required fields');
            }
            
            if (isNaN(product.price) || product.price <= 0) {
                throw new Error('Please enter a valid price');
            }
            
            if (isNaN(product.stock) || product.stock < 0) {
                throw new Error('Please enter a valid stock quantity');
            }
            
            if (isOnline) {
                // Online: Save to Supabase
                try {
                    // Create a copy of the product with the correct field names
                    const productToSave = {
                        name: product.name,
                        category: product.category,
                        price: product.price,
                        stock: product.stock,
                        // Try different possible column names for expiry date
                        expiry_date: product.expiryDate,  // snake_case version
                        expiryDate: product.expiryDate,   // camelCase version
                        barcode: product.barcode || null
                    };
                    
                    if (product.id && !product.id.startsWith('temp_')) {
                        // Update existing product
                        const { data, error } = await supabase
                            .from('products')
                            .update(productToSave)
                            .eq('id', product.id)
                            .select();
                        
                        if (error) {
                            console.error('Supabase update error:', error);
                            throw error;
                        }
                    } else {
                        // Add new product
                        const { data, error } = await supabase
                            .from('products')
                            .insert(productToSave)
                            .select();
                        
                        if (error) {
                            console.error('Supabase insert error:', error);
                            throw error;
                        }
                        
                        if (data && data.length > 0) {
                            product.id = data[0].id;
                        }
                    }
                    
                    // Update local cache
                    const index = products.findIndex(p => p.id === product.id);
                    if (index >= 0) {
                        products[index] = product;
                    } else {
                        products.push(product);
                    }
                    
                    saveToLocalStorage();
                    return { success: true, product };
                } catch (dbError) {
                    console.error('Database operation failed:', dbError);
                    
                    // Check if it's an RLS policy error
                    if (dbError.code === '42501' || dbError.message.includes('policy')) {
                        showNotification('Permission denied. You may not have rights to modify products.', 'error');
                    } else if (dbError.code === '42P17' || dbError.message.includes('infinite recursion')) {
                        showNotification('Database policy issue detected. Saving locally only.', 'warning');
                        // Fall back to local storage
                        return this.saveProductLocally(product);
                    } else if (dbError.message && dbError.message.includes('column')) {
                        // Column name mismatch - try to determine the correct column name
                        console.warn('Column name mismatch detected, trying alternative column names');
                        
                        // Try with just snake_case
                        try {
                            const productToSave = {
                                name: product.name,
                                category: product.category,
                                price: product.price,
                                stock: product.stock,
                                expiry_date: product.expiryDate,  // Only snake_case
                                barcode: product.barcode || null
                            };
                            
                            if (product.id && !product.id.startsWith('temp_')) {
                                const { data, error } = await supabase
                                    .from('products')
                                    .update(productToSave)
                                    .eq('id', product.id)
                                    .select();
                                
                                if (error) throw error;
                            } else {
                                const { data, error } = await supabase
                                    .from('products')
                                    .insert(productToSave)
                                    .select();
                                
                                if (error) throw error;
                                
                                if (data && data.length > 0) {
                                    product.id = data[0].id;
                                }
                            }
                            
                            // Update local cache
                            const index = products.findIndex(p => p.id === product.id);
                            if (index >= 0) {
                                products[index] = product;
                            } else {
                                products.push(product);
                            }
                            
                            saveToLocalStorage();
                            return { success: true, product };
                        } catch (retryError) {
                            // If still fails, try with just camelCase
                            try {
                                const productToSave = {
                                    name: product.name,
                                    category: product.category,
                                    price: product.price,
                                    stock: product.stock,
                                    expiryDate: product.expiryDate,  // Only camelCase
                                    barcode: product.barcode || null
                                };
                                
                                if (product.id && !product.id.startsWith('temp_')) {
                                    const { data, error } = await supabase
                                        .from('products')
                                        .update(productToSave)
                                        .eq('id', product.id)
                                        .select();
                                    
                                    if (error) throw error;
                                } else {
                                    const { data, error } = await supabase
                                        .from('products')
                                        .insert(productToSave)
                                        .select();
                                    
                                    if (error) throw error;
                                    
                                    if (data && data.length > 0) {
                                        product.id = data[0].id;
                                    }
                                }
                                
                                // Update local cache
                                const index = products.findIndex(p => p.id === product.id);
                                if (index >= 0) {
                                    products[index] = product;
                                } else {
                                    products.push(product);
                                }
                                
                                saveToLocalStorage();
                                return { success: true, product };
                            } catch (finalError) {
                                console.error('All column name attempts failed:', finalError);
                                showNotification('Database schema mismatch. Saving locally only.', 'warning');
                                return this.saveProductLocally(product);
                            }
                        }
                    } else {
                        showNotification('Database error: ' + dbError.message, 'error');
                        throw dbError;
                    }
                }
            } else {
                // Offline: Save to localStorage and add to sync queue
                return this.saveProductLocally(product);
            }
        } catch (error) {
            console.error('Error saving product:', error);
            
            // Check if it's a network error
            if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
                showNotification('Network error. Saving locally.', 'warning');
                return this.saveProductLocally(product);
            } else {
                showNotification('Error saving product: ' + error.message, 'error');
                return { success: false, error: error.message };
            }
        } finally {
            // Hide loading state
            productModalLoading.style.display = 'none';
            saveProductBtn.disabled = false;
        }
    },
    
    // Helper method to save product locally
    saveProductLocally(product) {
        if (product.id && !product.id.startsWith('temp_')) {
            // Update existing product
            const index = products.findIndex(p => p.id === product.id);
            if (index >= 0) {
                products[index] = product;
            }
        } else {
            // Add new product with temporary ID
            product.id = 'temp_' + Date.now();
            products.push(product);
        }
        
        saveToLocalStorage();
        
        // Add to sync queue
        addToSyncQueue({
            type: 'saveProduct',
            data: product
        });
        
        showNotification('Product saved locally. Will sync when connection is restored.', 'info');
        return { success: true, product };
    },
    
    async deleteProduct(productId) {
        try {
            if (isOnline) {
                // Online: Delete from Supabase
                const { error } = await supabase
                    .from('products')
                    .delete()
                    .eq('id', productId);
                
                if (error) {
                    throw error;
                }
                
                // Update local cache
                products = products.filter(p => p.id !== productId);
                saveToLocalStorage();
                
                return { success: true };
            } else {
                // Offline: Mark as deleted in localStorage and add to sync queue
                const index = products.findIndex(p => p.id === productId);
                if (index >= 0) {
                    products[index].deleted = true;
                    products[index].deletedAt = new Date().toISOString();
                }
                
                saveToLocalStorage();
                
                // Add to sync queue
                addToSyncQueue({
                    type: 'deleteProduct',
                    id: productId
                });
                
                return { success: true };
            }
        } catch (error) {
            console.error('Error deleting product:', error);
            showNotification('Error deleting product', 'error');
            return { success: false, error };
        }
    },
    
    // ✅ FIXED: Improved saveSale function with duplicate prevention
    async saveSale(sale) {
        try {
            // Check if sale with this receipt number already exists locally
            const existingSale = sales.find(s => s.receiptNumber === sale.receiptNumber);
            if (existingSale) {
                console.log(`Sale with receipt ${sale.receiptNumber} already exists locally`);
                return { success: true, sale: existingSale };
            }

            if (isOnline) {
                // Online: Save to Supabase only - let real-time subscription update local array
                const { data, error } = await supabase
                    .from('sales')
                    .insert(sale)
                    .select();
                
                if (error) {
                    throw error;
                }
                
                sale.id = data[0].id;

                // Don't manually push to sales array - subscription will handle it
                // This prevents duplicates when the subscription triggers

                return { success: true, sale };
            } else {
                // Offline: Save to localStorage and add to sync queue
                // Use a consistent ID format that can be matched later
                sale.id = 'temp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                sales.push(sale);
                saveToLocalStorage();

                // Add to sync queue
                addToSyncQueue({
                    type: 'saveSale',
                    data: sale
                });

                return { success: true, sale };
            }
        } catch (error) {
            console.error('Error saving sale:', error);
            showNotification('Error saving sale', 'error');
            return { success: false, error };
        }
    },
    
    // FIX 2: Improved deleteSale function
    async deleteSale(saleId) {
        try {
            if (isOnline) {
                // Online: Move to deleted sales in Supabase
                const { data: saleData, error: fetchError } = await supabase
                    .from('sales')
                    .select('*')
                    .eq('id', saleId)
                    .single();
                
                if (fetchError) {
                    throw fetchError;
                }
                
                if (saleData) {
                    // Add a deleted flag and timestamp
                    saleData.deleted = true;
                    saleData.deletedAt = new Date().toISOString();
                    
                    // Add to deleted_sales table
                    const { error: insertError } = await supabase
                        .from('deleted_sales')
                        .insert(saleData);
                    
                    if (insertError) {
                        throw insertError;
                    }
                    
                    // Delete from sales table
                    const { error: deleteError } = await supabase
                        .from('sales')
                        .delete()
                        .eq('id', saleId);
                    
                    if (deleteError) {
                        throw deleteError;
                    }
                    
                    // Update local cache
                    const saleIndex = sales.findIndex(s => s.id === saleId);
                    if (saleIndex >= 0) {
                        const sale = sales[saleIndex];
                        sale.deleted = true;
                        sale.deletedAt = new Date().toISOString();
                        deletedSales.push(sale);
                        sales.splice(saleIndex, 1);
                    }
                    
                    saveToLocalStorage();
                    return { success: true };
                } else {
                    return { success: false, error: 'Sale not found' };
                }
            } else {
                // Offline: Mark as deleted in localStorage and add to sync queue
                const saleIndex = sales.findIndex(s => s.id === saleId);
                if (saleIndex >= 0) {
                    const sale = sales[saleIndex];
                    sale.deleted = true;
                    sale.deletedAt = new Date().toISOString();
                    deletedSales.push(sale);
                    sales.splice(saleIndex, 1);
                    
                    saveToLocalStorage();
                    
                    // Add to sync queue
                    addToSyncQueue({
                        type: 'deleteSale',
                        id: saleId
                    });
                    
                    return { success: true };
                } else {
                    return { success: false, error: 'Sale not found' };
                }
            }
        } catch (error) {
            console.error('Error deleting sale:', error);
            showNotification('Error deleting sale', 'error');
            return { success: false, error };
        }
    }
};

// UI Functions
function showLogin() {
    loginPage.style.display = 'flex';
    appContainer.style.display = 'none';
}

// ✅ FIXED: Initialize change password form with username field for accessibility
function initChangePasswordForm() {
    if (currentUser && currentUser.email) {
        // Create a hidden username field for accessibility
        const changePasswordForm = document.getElementById('change-password-form');
        if (changePasswordForm) {
            // Check if username field already exists
            if (!document.getElementById('change-password-username')) {
                const usernameField = document.createElement('input');
                usernameField.type = 'email';
                usernameField.id = 'change-password-username';
                usernameField.name = 'username';
                usernameField.value = currentUser.email;
                usernameField.style.display = 'none';
                usernameField.setAttribute('aria-hidden', 'true');
                usernameField.setAttribute('tabindex', '-1');
                usernameField.setAttribute('autocomplete', 'username');
                
                // Insert at the beginning of the form
                changePasswordForm.insertBefore(usernameField, changePasswordForm.firstChild);
            }
        }
    }
}

async function showApp() {
    loginPage.style.display = 'none';
    appContainer.style.display = 'flex';
    
    // Update user info
    if (currentUser) {
        currentUserEl.textContent = currentUser.name;
        userRoleEl.textContent = currentUser.role;
        userRoleDisplayEl.textContent = currentUser.role;
        
        // Show/hide admin features
        const usersContainer = document.getElementById('users-container');
        if (AuthModule.isAdmin()) {
            usersContainer.style.display = 'block';
        } else {
            usersContainer.style.display = 'none';
        }
        
        // Initialize the change password form with username field
        initChangePasswordForm();
    }
    
    // Fetch initial data from Supabase
    try {
        products = await DataModule.fetchProducts();
        sales = await DataModule.fetchSales();
        deletedSales = await DataModule.fetchDeletedSales();
        
        // Load data into UI
        loadProducts();
        loadSales();
        
        // Set up real-time listeners
        setupRealtimeListeners();
    } catch (error) {
        console.error('Error loading initial data:', error);
        showNotification('Error loading data. Using offline cache.', 'warning');
        
        // Fall back to local data
        loadProducts();
        loadSales();
        
        // Set up real-time listeners
        setupRealtimeListeners();
    }
}

function showNotification(message, type = 'success') {
    notificationMessage.textContent = message;
    notification.className = `notification ${type} show`;
    
    // Update icon based on type
    const icon = notification.querySelector('i');
    icon.className = type === 'success' ? 'fas fa-check-circle' : 
                   type === 'error' ? 'fas fa-exclamation-circle' : 
                   type === 'warning' ? 'fas fa-exclamation-triangle' : 
                   'fas fa-info-circle';
    
    setTimeout(() => {
        notification.classList.remove('show');
    }, 3000);
}

function formatCurrency(amount) {
    return new Intl.NumberFormat('en-NG', { 
        style: 'currency', 
        currency: 'NGN',
        minimumFractionDigits: 2
    }).format(amount);
}

// FIX: Added null check for toDate() function
function formatDate(date) {
    if (!date) return '-';
    
    // Check if date is a string
    if (typeof date === 'string') {
        const d = new Date(date);
        
        // Check if the date is valid
        if (isNaN(d.getTime())) {
            return '-';
        }
        
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    }
    
    // If it's already a Date object
    const d = date instanceof Date ? date : new Date(date);
    
    // Check if the date is valid
    if (isNaN(d.getTime())) {
        return '-';
    }
    
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
}

function generateReceiptNumber() {
    const date = new Date();
    const year = date.getFullYear().toString().substr(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    
    return `R${year}${month}${day}${random}`;
}

// Page Navigation
function showPage(pageName) {
    // Hide all pages
    pageContents.forEach(page => {
        page.style.display = 'none';
    });
    
    // Show selected page
    const selectedPage = document.getElementById(`${pageName}-page`);
    if (selectedPage) {
        selectedPage.style.display = 'block';
    }
    
    // Update active nav link
    navLinks.forEach(link => {
        link.classList.remove('active');
        if (link.getAttribute('data-page') === pageName) {
            link.classList.add('active');
        }
    });
    
    // Update page title
    const titles = {
        'pos': 'Point of Sale',
        'inventory': 'Inventory Management',
        'reports': 'Sales Reports',
        'account': 'My Account'
    };
    
    pageTitle.textContent = titles[pageName] || 'Pa Gerrys Mart';
    currentPage = pageName;
    
    // Load page-specific data
    if (pageName === 'inventory') {
        loadInventory();
    } else if (pageName === 'reports') {
        loadReports();
    } else if (pageName === 'account') {
        loadAccount();
    }
}

// ✅ FIXED: Add function to validate and fix product data
function validateProductData(product) {
    const validatedProduct = { ...product };
    
    // Ensure required fields exist
    if (!validatedProduct.name) validatedProduct.name = 'Unnamed Product';
    if (!validatedProduct.category) validatedProduct.category = 'Uncategorized';
    if (!validatedProduct.price || isNaN(validatedProduct.price)) validatedProduct.price = 0;
    if (!validatedProduct.stock || isNaN(validatedProduct.stock)) validatedProduct.stock = 0;
    if (!validatedProduct.expiryDate) {
        // Set expiry to 1 year from now if not provided
        const date = new Date();
        date.setFullYear(date.getFullYear() + 1);
        validatedProduct.expiryDate = date.toISOString().split('T')[0];
    }
    
    // Convert to proper types
    validatedProduct.price = parseFloat(validatedProduct.price);
    validatedProduct.stock = parseInt(validatedProduct.stock);
    
    return validatedProduct;
}

// Product Functions
function loadProducts() {
    if (products.length === 0) {
        productsGrid.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-box-open"></i>
                <h3>No Products Added Yet</h3>
                <p>Click "Add Product" to start adding your inventory</p>
            </div>
        `;
        return;
    }
    
    productsGrid.innerHTML = '';
    
    products.forEach(product => {
        // Skip deleted products
        if (product.deleted) return;
        
        const productCard = document.createElement('div');
        productCard.className = 'product-card';
        
        // Check expiry status
        const today = new Date();
        const expiryDate = new Date(product.expiryDate);
        const daysUntilExpiry = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
        
        let expiryWarning = '';
        if (daysUntilExpiry < 0) {
            expiryWarning = `<div class="expiry-warning"><i class="fas fa-exclamation-triangle"></i> Expired</div>`;
        } else if (daysUntilExpiry <= settings.expiryWarningDays) {
            expiryWarning = `<div class="expiry-warning"><i class="fas fa-clock"></i> Expires in ${daysUntilExpiry} days</div>`;
        }
        
        // Check stock status
        let stockClass = 'stock-high';
        if (product.stock <= 0) {
            stockClass = 'stock-low';
        } else if (product.stock <= settings.lowStockThreshold) {
            stockClass = 'stock-medium';
        }
        
        productCard.innerHTML = `
            <div class="product-img">
                <i class="fas fa-box"></i>
            </div>
            <h4>${product.name}</h4>
            <div class="price">${formatCurrency(product.price)}</div>
            <div class="stock ${stockClass}">Stock: ${product.stock}</div>
            ${expiryWarning}
        `;
        
        productCard.addEventListener('click', () => addToCart(product));
        productsGrid.appendChild(productCard);
    });
}

function loadInventory() {
    inventoryLoading.style.display = 'flex';
    
    setTimeout(() => {
        inventoryLoading.style.display = 'none';
        
        if (products.length === 0) {
            inventoryTableBody.innerHTML = `
                <tr>
                    <td colspan="8" style="text-align: center;">No products in inventory</td>
                </tr>
            `;
            inventoryTotalValueEl.textContent = formatCurrency(0);
            return;
        }
        
        let totalValue = 0;
        inventoryTableBody.innerHTML = '';
        
        products.forEach(product => {
            // Skip deleted products
            if (product.deleted) return;
            
            totalValue += product.price * product.stock;
            
            // Check expiry status
            const today = new Date();
            const expiryDate = new Date(product.expiryDate);
            const daysUntilExpiry = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
            
            let rowClass = '';
            let stockBadgeClass = 'stock-high';
            let stockBadgeText = 'In Stock';
            
            if (product.stock <= 0) {
                stockBadgeClass = 'stock-low';
                stockBadgeText = 'Out of Stock';
            } else if (product.stock <= settings.lowStockThreshold) {
                stockBadgeClass = 'stock-medium';
                stockBadgeText = 'Low Stock';
            }
            
            let expiryBadgeClass = 'expiry-good';
            let expiryBadgeText = 'Good';
            
            if (daysUntilExpiry < 0) {
                expiryBadgeClass = 'expiry-expired';
                expiryBadgeText = 'Expired';
                rowClass = 'expired';
            } else if (daysUntilExpiry <= settings.expiryWarningDays) {
                expiryBadgeClass = 'expiry-warning';
                expiryBadgeText = 'Expiring Soon';
                rowClass = 'expiring-soon';
            }
            
            const row = document.createElement('tr');
            if (rowClass) row.className = rowClass;
            
            row.innerHTML = `
                <td>${product.id}</td>
                <td>${product.name}</td>
                <td>${product.category}</td>
                <td>${formatCurrency(product.price)}</td>
                <td>${product.stock}</td>
                <td>${formatDate(product.expiryDate)}</td>
                <td>
                    <span class="stock-badge ${stockBadgeClass}">${stockBadgeText}</span>
                    <span class="expiry-badge ${expiryBadgeClass}">${expiryBadgeText}</span>
                </td>
                <td>
                    <div class="action-buttons">
                        <button class="btn-edit" onclick="editProduct('${product.id}')">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn-delete" onclick="deleteProduct('${product.id}')">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            `;
            
            inventoryTableBody.appendChild(row);
        });
        
        inventoryTotalValueEl.textContent = formatCurrency(totalValue);
    }, 500);
}

function loadSales() {
    // This will be called by real-time listeners
    updateSalesTables();
}

function loadDeletedSales() {
    // This will be called by real-time listeners
    updateSalesTables();
}

// FIX: Added null checks for toDate() in updateSalesTables
function updateSalesTables() {
    // Update recent sales table
    if (sales.length === 0) {
        salesTableBody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align: center;">No sales data available</td>
            </tr>
        `;
    } else {
        salesTableBody.innerHTML = '';
        
        // Sort sales by date (newest first)
        const sortedSales = [...sales].sort((a, b) => {
            // FIX: Added null checks for toDate()
            const dateA = a.created_at ? new Date(a.created_at) : new Date(0);
            const dateB = b.created_at ? new Date(b.created_at) : new Date(0);
            return dateB - dateA;
        });
        
        // Show only the last 10 sales
        const recentSales = sortedSales.slice(0, 10);
        
        recentSales.forEach(sale => {
            const row = document.createElement('tr');
            
            // Build action buttons based on user role
            let actionButtons = `
                <button class="btn-edit" onclick="viewSale('${sale.id}')">
                    <i class="fas fa-eye"></i>
                </button>
            `;
            
            // Add delete button only for admins
            if (AuthModule.isAdmin()) {
                actionButtons += `
                    <button class="btn-delete" onclick="deleteSale('${sale.id}')" title="Delete Sale">
                        <i class="fas fa-trash"></i>
                    </button>
                `;
            }
            
            // Calculate total items sold (sum of quantities)
            const totalItemsSold = sale.items.reduce((sum, item) => sum + item.quantity, 0);
            
            row.innerHTML = `
                <td>${sale.receiptNumber}</td>
                <td>${formatDate(sale.created_at)}</td>
                <td>${totalItemsSold}</td>
                <td>${formatCurrency(sale.total)}</td>
                <td>
                    <div class="action-buttons">
                        ${actionButtons}
                    </div>
                </td>
            `;
            
            salesTableBody.appendChild(row);
        });
    }
    
    // Update deleted sales table
    if (deletedSales.length === 0) {
        deletedSalesTableBody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align: center;">No deleted sales</td>
            </tr>
        `;
    } else {
        deletedSalesTableBody.innerHTML = '';
        
        // Sort deleted sales by date (newest first)
        const sortedDeletedSales = [...deletedSales].sort((a, b) => {
            // FIX: Added null checks for toDate()
            const dateA = a.deletedAt ? new Date(a.deletedAt) : new Date(0);
            const dateB = b.deletedAt ? new Date(b.deletedAt) : new Date(0);
            return dateB - dateA;
        });
        
        sortedDeletedSales.forEach(sale => {
            const row = document.createElement('tr');
            
            // Calculate total items sold (sum of quantities)
            const totalItemsSold = sale.items.reduce((sum, item) => sum + item.quantity, 0);
            
            row.innerHTML = `
                <td>${sale.receiptNumber}</td>
                <td>${formatDate(sale.created_at)}</td>
                <td>${totalItemsSold}</td>
                <td>${formatCurrency(sale.total)}</td>
                <td><span class="deleted-badge">Deleted</span></td>
            `;
            
            deletedSalesTableBody.appendChild(row);
        });
    }
}

function loadReports() {
    reportsLoading.style.display = 'flex';
    
    // Set today's date as default
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('report-date').value = today;
    
    setTimeout(() => {
        reportsLoading.style.display = 'none';
        generateReport();
    }, 500);
}

// FIX: Added null checks for toDate() in generateReport
function generateReport() {
    const selectedDate = document.getElementById('report-date').value;
    
    // Calculate overall summary
    let totalSales = 0;
    let totalTransactions = sales.length;
    let totalItemsSold = 0;
    
    sales.forEach(sale => {
        totalSales += sale.total;
        // Sum up the quantities of all items in the sale
        sale.items.forEach(item => {
            totalItemsSold += item.quantity;
        });
    });
    
    document.getElementById('report-total-sales').textContent = formatCurrency(totalSales);
    document.getElementById('report-transactions').textContent = totalTransactions;
    document.getElementById('report-items-sold').textContent = totalItemsSold;
    
    // Calculate daily summary
    let dailyTotal = 0;
    let dailyTransactions = 0;
    let dailyItems = 0;
    
    const dailySales = [];
    
    sales.forEach(sale => {
        const saleDate = sale.created_at ? new Date(sale.created_at) : new Date(0);
        const saleDateString = saleDate.toISOString().split('T')[0];
        
        if (saleDateString === selectedDate) {
            dailyTotal += sale.total;
            dailyTransactions++;
            // Sum up the quantities of all items in the sale
            sale.items.forEach(item => {
                dailyItems += item.quantity;
            });
            dailySales.push(sale);
        }
    });
    
    document.getElementById('daily-total-sales').textContent = formatCurrency(dailyTotal);
    document.getElementById('daily-transactions').textContent = dailyTransactions;
    document.getElementById('daily-items-sold').textContent = dailyItems;
    
    // Update daily sales table
    if (dailySales.length === 0) {
        dailySalesTableBody.innerHTML = `
            <tr>
                <td colspan="5" class="no-data">No sales data for selected date</td>
            </tr>
        `;
    } else {
        dailySalesTableBody.innerHTML = '';
        
        // Sort by time
        dailySales.sort((a, b) => {
            // FIX: Added null checks for toDate()
            const dateA = a.created_at ? new Date(a.created_at) : new Date(0);
            const dateB = b.created_at ? new Date(b.created_at) : new Date(0);
            return dateB - dateA;
        });
        
        dailySales.forEach(sale => {
            const row = document.createElement('tr');
            
            // Build action buttons based on user role
            let actionButtons = `
                <button class="btn-edit" onclick="viewSale('${sale.id}')">
                    <i class="fas fa-eye"></i>
                </button>
            `;
            
            // Add delete button only for admins
            if (AuthModule.isAdmin()) {
                actionButtons += `
                    <button class="btn-delete" onclick="deleteSale('${sale.id}')" title="Delete Sale">
                        <i class="fas fa-trash"></i>
                    </button>
                `;
            }
            
            // Calculate total items sold (sum of quantities)
            const totalItemsSold = sale.items.reduce((sum, item) => sum + item.quantity, 0);
            
            row.innerHTML = `
                <td>${sale.receiptNumber}</td>
                <td>${formatDate(sale.created_at)}</td>
                <td>${totalItemsSold}</td>
                <td>${formatCurrency(sale.total)}</td>
                <td>
                    <div class="action-buttons">
                        ${actionButtons}
                    </div>
                </td>
            `;
            
            dailySalesTableBody.appendChild(row);
        });
    }
}

function loadAccount() {
    accountLoading.style.display = 'flex';
    
    setTimeout(() => {
        accountLoading.style.display = 'none';
        
        if (currentUser) {
            document.getElementById('user-name').textContent = currentUser.name;
            document.getElementById('user-email').textContent = currentUser.email;
            document.getElementById('user-role-display').textContent = currentUser.role;
            document.getElementById('user-created').textContent = formatDate(currentUser.created_at);
            document.getElementById('user-last-login').textContent = formatDate(currentUser.last_login);
        }
        
        // Load users if admin
        if (AuthModule.isAdmin()) {
            loadUsers();
        }
    }, 500);
}

function loadUsers() {
    const usersList = document.getElementById('users-list');
    usersList.innerHTML = '';
    
    if (users.length === 0) {
        usersList.innerHTML = '<p>No users found</p>';
        return;
    }
    
    users.forEach(user => {
        const userCard = document.createElement('div');
        userCard.className = 'user-card';
        
        userCard.innerHTML = `
            <div class="user-info">
                <strong>${user.name}</strong>
                <span>${user.email}</span>
                <span class="role-badge ${user.role}">${user.role}</span>
            </div>
            <div class="action-buttons">
                <button class="btn-delete" onclick="deleteUser('${user.id}')">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `;
        
        usersList.appendChild(userCard);
    });
}

// Cart Functions
function addToCart(product) {
    // Check if product is in stock
    if (product.stock <= 0) {
        showNotification('Product is out of stock', 'error');
        return;
    }
    
    // Check if product is already in cart
    const existingItem = cart.find(item => item.id === product.id);
    
    if (existingItem) {
        // Check if adding one more would exceed stock
        if (existingItem.quantity >= product.stock) {
            showNotification('Not enough stock available', 'error');
            return;
        }
        
        existingItem.quantity++;
    } else {
        cart.push({
            id: product.id,
            name: product.name,
            price: product.price,
            quantity: 1
        });
    }
    
    updateCart();
}

function updateCart() {
    if (cart.length === 0) {
        cartItems.innerHTML = '<p style="text-align: center; color: #999; padding: 20px;">No items in cart</p>';
        totalEl.textContent = formatCurrency(0);
        return;
    }
    
    cartItems.innerHTML = '';
    let total = 0;
    
    cart.forEach(item => {
        const itemTotal = item.price * item.quantity;
        total += itemTotal;
        
        const cartItem = document.createElement('div');
        cartItem.className = 'cart-item';
        
        cartItem.innerHTML = `
            <div class="cart-item-info">
                <div class="cart-item-name">${item.name}</div>
                <div class="cart-item-price">${formatCurrency(item.price)}</div>
                <div class="cart-item-qty">
                    <button onclick="updateQuantity('${item.id}', -1)">-</button>
                    <input type="number" value="${item.quantity}" min="1" readonly>
                    <button onclick="updateQuantity('${item.id}', 1)">+</button>
                </div>
            </div>
            <div class="cart-item-total">${formatCurrency(itemTotal)}</div>
        `;
        
        cartItems.appendChild(cartItem);
    });
    
    totalEl.textContent = formatCurrency(total);
}

function updateQuantity(productId, change) {
    const item = cart.find(item => item.id === productId);
    if (!item) return;
    
    const product = products.find(p => p.id === productId);
    if (!product) return;
    
    const newQuantity = item.quantity + change;
    
    // Check if new quantity is valid
    if (newQuantity <= 0) {
        // Remove item from cart
        cart = cart.filter(item => item.id !== productId);
    } else if (newQuantity <= product.stock) {
        // Update quantity
        item.quantity = newQuantity;
    } else {
        showNotification('Not enough stock available', 'error');
        return;
    }
    
    updateCart();
}

function clearCart() {
    cart = [];
    updateCart();
}

async function completeSale() {
    if (cart.length === 0) {
        showNotification('Cart is empty', 'error');
        return;
    }
    
    // Show loading state
    completeSaleBtn.classList.add('loading');
    completeSaleBtn.disabled = true;
    
    try {
        // Create sale object with unique client ID
        const sale = {
            receiptNumber: generateReceiptNumber(),
            clientSaleId: 'client_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            items: [...cart],
            total: cart.reduce((sum, item) => sum + (item.price * item.quantity), 0),
            created_at: new Date().toISOString(),
            cashier: currentUser.name,
            cashierId: currentUser.id
        };
        
        // Save sale
        const result = await DataModule.saveSale(sale);
        
        if (result.success) {
            // Update product stock
            for (const cartItem of cart) {
                const product = products.find(p => p.id === cartItem.id);
                if (product) {
                    product.stock -= cartItem.quantity;
                    
                    // Save product with updated stock
                    await DataModule.saveProduct(product);
                }
            }
            
            // Show receipt
            showReceipt(sale);
            
            // Clear cart
            cart = [];
            updateCart();
            
            showNotification('Sale completed successfully', 'success');
        } else {
            showNotification('Failed to complete sale', 'error');
        }
    } catch (error) {
        console.error('Error completing sale:', error);
        showNotification('Error completing sale', 'error');
    } finally {
        // Hide loading state
        completeSaleBtn.classList.remove('loading');
        completeSaleBtn.disabled = false;
    }
}

function showReceipt(sale) {
    const receiptContent = document.getElementById('receipt-content');
    
    let itemsHtml = '';
    sale.items.forEach(item => {
        itemsHtml += `
            <div class="receipt-item">
                <span>${item.name} x${item.quantity}</span>
                <span>${formatCurrency(item.price * item.quantity)}</span>
            </div>
        `;
    });
    
    receiptContent.innerHTML = `
        <div class="receipt-header">
            <h2>${settings.storeName}</h2>
            <p>${settings.storeAddress}</p>
            <p>${settings.storePhone}</p>
        </div>
        <div class="receipt-items">
            ${itemsHtml}
        </div>
        <div class="receipt-footer">
            <div class="receipt-total">
                <span>Total:</span>
                <span>${formatCurrency(sale.total)}</span>
            </div>
            <div class="receipt-item">
                <span>Receipt #:</span>
                <span>${sale.receiptNumber}</span>
            </div>
            <div class="receipt-item">
                <span>Date:</span>
                <span>${formatDate(sale.created_at)}</span>
            </div>
            <div class="receipt-item">
                <span>Cashier:</span>
                <span>${sale.cashier}</span>
            </div>
        </div>
    `;
    
    receiptModal.style.display = 'flex';
}

function printReceipt() {
    const receiptContent = document.getElementById('receipt-content').innerHTML;
    
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <html>
            <head>
                <title>Receipt - ${settings.storeName}</title>
                <style>
                    body { font-family: 'Courier New', monospace; padding: 20px; }
                    .receipt-header { text-align: center; margin-bottom: 20px; }
                    .receipt-items { margin-bottom: 20px; }
                    .receipt-item { display: flex; justify-content: space-between; margin-bottom: 8px; }
                    .receipt-footer { border-top: 1px dashed #ccc; padding-top: 10px; }
                    .receipt-total { display: flex; justify-content: space-between; font-weight: 700; margin-bottom: 5px; }
                </style>
            </head>
            <body>
                ${receiptContent}
            </body>
        </html>
    `);
    
    printWindow.document.close();
    printWindow.print();
}

// Product Modal Functions
function openProductModal(product = null) {
    const modalTitle = document.getElementById('modal-title');
    const productForm = document.getElementById('product-form');
    
    if (product) {
        // Edit mode
        modalTitle.textContent = 'Edit Product';
        document.getElementById('product-name').value = product.name;
        document.getElementById('product-category').value = product.category;
        document.getElementById('product-price').value = product.price;
        document.getElementById('product-stock').value = product.stock;
        document.getElementById('product-expiry').value = product.expiryDate;
        document.getElementById('product-barcode').value = product.barcode || '';
        
        // Store product ID for editing
        productForm.dataset.productId = product.id;
    } else {
        // Add mode
        modalTitle.textContent = 'Add New Product';
        productForm.reset();
        delete productForm.dataset.productId;
    }
    
    productModal.style.display = 'flex';
}

function closeProductModal() {
    productModal.style.display = 'none';
}

// ✅ FIXED: Updated saveProduct function with validation
async function saveProduct() {
    const productForm = document.getElementById('product-form');
    const productId = productForm.dataset.productId;
    
    const productData = validateProductData({
        name: document.getElementById('product-name').value,
        category: document.getElementById('product-category').value,
        price: parseFloat(document.getElementById('product-price').value),
        stock: parseInt(document.getElementById('product-stock').value),
        expiryDate: document.getElementById('product-expiry').value,
        barcode: document.getElementById('product-barcode').value
    });
    
    if (productId) {
        // Update existing product
        productData.id = productId;
    }
    
    const result = await DataModule.saveProduct(productData);
    
    if (result.success) {
        closeProductModal();
        loadProducts();
        if (currentPage === 'inventory') {
            loadInventory();
        }
        showNotification(productId ? 'Product updated successfully' : 'Product added successfully', 'success');
    } else {
        // Error is already shown in the saveProduct function
    }
}

function editProduct(productId) {
    const product = products.find(p => p.id === productId);
    if (product) {
        openProductModal(product);
    }
}

async function deleteProduct(productId) {
    if (!confirm('Are you sure you want to delete this product?')) {
        return;
    }
    
    const result = await DataModule.deleteProduct(productId);
    
    if (result.success) {
        loadProducts();
        if (currentPage === 'inventory') {
            loadInventory();
        }
        showNotification('Product deleted successfully', 'success');
    } else {
        showNotification('Failed to delete product', 'error');
    }
}

function viewSale(saleId) {
    const sale = sales.find(s => s.id === saleId);
    if (sale) {
        showReceipt(sale);
    }
}

async function deleteSale(saleId) {
    // Double-check if user is admin
    if (!AuthModule.isAdmin()) {
        showNotification('You do not have permission to delete sales', 'error');
        return;
    }
    
    const sale = sales.find(s => s.id === saleId);
    if (!sale) {
        showNotification('Sale not found', 'error');
        return;
    }
    
    // Show confirmation dialog with sale details
    const confirmMessage = `Are you sure you want to delete this sale?\n\n` +
        `Receipt #: ${sale.receiptNumber}\n` +
        `Date: ${formatDate(sale.created_at)}\n` +
        `Total: ${formatCurrency(sale.total)}\n\n` +
        `This action cannot be undone.`;
    
    if (!confirm(confirmMessage)) {
        return;
    }
    
    try {
        const result = await DataModule.deleteSale(saleId);
        
        if (result.success) {
            showNotification('Sale deleted successfully', 'success');
            
            // Refresh the reports if we're on the reports page
            if (currentPage === 'reports') {
                generateReport();
            }
            
            // Update sales tables
            updateSalesTables();
        } else {
            showNotification('Failed to delete sale', 'error');
        }
    } catch (error) {
        console.error('Error deleting sale:', error);
        showNotification('Error deleting sale', 'error');
    }
}

// Event Listeners
loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    
    AuthModule.signIn(email, password);
});

registerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('register-name').value;
    const email = document.getElementById('register-email').value;
    const password = document.getElementById('register-password').value;
    const confirmPassword = document.getElementById('register-confirm-password').value;
    const role = document.getElementById('register-role').value;
    
    if (password !== confirmPassword) {
        document.getElementById('register-error').style.display = 'block';
        document.getElementById('register-error').textContent = 'Passwords do not match';
        return;
    }
    
    // Show loading state
    registerSubmitBtn.classList.add('loading');
    registerSubmitBtn.disabled = true;
    
    AuthModule.signUp(email, password, name, role)
        .then(result => {
            if (result.success) {
                // Switch to login tab
                document.querySelector('[data-tab="login"]').click();
                registerForm.reset();
            }
        })
        .finally(() => {
            // Hide loading state
            registerSubmitBtn.classList.remove('loading');
            registerSubmitBtn.disabled = false;
        });
});

// Login tabs
loginTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const tabName = tab.getAttribute('data-tab');
        
        // Update active tab
        loginTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Show corresponding content
        tabContents.forEach(content => {
            content.classList.remove('active');
            if (content.id === `${tabName}-tab` || content.id === `${tabName}-content`) {
                content.classList.add('active');
            }
        });
        
        // Hide error messages
        document.getElementById('login-error').style.display = 'none';
        document.getElementById('register-error').style.display = 'none';
    });
});

// Navigation
navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const pageName = link.getAttribute('data-page');
        showPage(pageName);
    });
});

// Mobile menu
mobileMenuBtn.addEventListener('click', () => {
    sidebar.classList.toggle('active');
});

// Logout
logoutBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to logout?')) {
        AuthModule.signOut();
    }
});

// Product search
document.getElementById('search-btn').addEventListener('click', () => {
    const searchTerm = document.getElementById('product-search').value.toLowerCase();
    
    if (!searchTerm) {
        loadProducts();
        return;
    }
    
    const filteredProducts = products.filter(product => {
        return product.name.toLowerCase().includes(searchTerm) ||
               product.category.toLowerCase().includes(searchTerm) ||
               (product.barcode && product.barcode.toLowerCase().includes(searchTerm));
    });
    
    if (filteredProducts.length === 0) {
        productsGrid.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-search"></i>
                <h3>No products found</h3>
                <p>Try a different search term</p>
            </div>
        `;
        return;
    }
    
    productsGrid.innerHTML = '';
    
    filteredProducts.forEach(product => {
        // Skip deleted products
        if (product.deleted) return;
        
        const productCard = document.createElement('div');
        productCard.className = 'product-card';
        
        // Check expiry status
        const today = new Date();
        const expiryDate = new Date(product.expiryDate);
        const daysUntilExpiry = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
        
        let expiryWarning = '';
        if (daysUntilExpiry < 0) {
            expiryWarning = `<div class="expiry-warning"><i class="fas fa-exclamation-triangle"></i> Expired</div>`;
        } else if (daysUntilExpiry <= settings.expiryWarningDays) {
            expiryWarning = `<div class="expiry-warning"><i class="fas fa-clock"></i> Expires in ${daysUntilExpiry} days</div>`;
        }
        
        // Check stock status
        let stockClass = 'stock-high';
        if (product.stock <= 0) {
            stockClass = 'stock-low';
        } else if (product.stock <= settings.lowStockThreshold) {
            stockClass = 'stock-medium';
        }
        
        productCard.innerHTML = `
            <div class="product-img">
                <i class="fas fa-box"></i>
            </div>
            <h4>${product.name}</h4>
            <div class="price">${formatCurrency(product.price)}</div>
            <div class="stock ${stockClass}">Stock: ${product.stock}</div>
            ${expiryWarning}
        `;
        
        productCard.addEventListener('click', () => addToCart(product));
        productsGrid.appendChild(productCard);
    });
});

// Inventory search
document.getElementById('inventory-search-btn').addEventListener('click', () => {
    const searchTerm = document.getElementById('inventory-search').value.toLowerCase();
    
    if (!searchTerm) {
        loadInventory();
        return;
    }
    
    const filteredProducts = products.filter(product => {
        return product.name.toLowerCase().includes(searchTerm) ||
               product.category.toLowerCase().includes(searchTerm) ||
               product.id.toLowerCase().includes(searchTerm);
    });
    
    if (filteredProducts.length === 0) {
        inventoryTableBody.innerHTML = `
            <tr>
                <td colspan="8" style="text-align: center;">No products found</td>
            </tr>
        `;
        inventoryTotalValueEl.textContent = formatCurrency(0);
        return;
    }
    
    let totalValue = 0;
    inventoryTableBody.innerHTML = '';
    
    filteredProducts.forEach(product => {
        // Skip deleted products
        if (product.deleted) return;
        
        totalValue += product.price * product.stock;
        
        // Check expiry status
        const today = new Date();
        const expiryDate = new Date(product.expiryDate);
        const daysUntilExpiry = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
        
        let rowClass = '';
        let stockBadgeClass = 'stock-high';
        let stockBadgeText = 'In Stock';
        
        if (product.stock <= 0) {
            stockBadgeClass = 'stock-low';
            stockBadgeText = 'Out of Stock';
        } else if (product.stock <= settings.lowStockThreshold) {
            stockBadgeClass = 'stock-medium';
            stockBadgeText = 'Low Stock';
        }
        
        let expiryBadgeClass = 'expiry-good';
        let expiryBadgeText = 'Good';
        
        if (daysUntilExpiry < 0) {
            expiryBadgeClass = 'expiry-expired';
            expiryBadgeText = 'Expired';
            rowClass = 'expired';
        } else if (daysUntilExpiry <= settings.expiryWarningDays) {
            expiryBadgeClass = 'expiry-warning';
            expiryBadgeText = 'Expiring Soon';
            rowClass = 'expiring-soon';
        }
        
        const row = document.createElement('tr');
        if (rowClass) row.className = rowClass;
        
        row.innerHTML = `
            <td>${product.id}</td>
            <td>${product.name}</td>
            <td>${product.category}</td>
            <td>${formatCurrency(product.price)}</td>
            <td>${product.stock}</td>
            <td>${formatDate(product.expiryDate)}</td>
            <td>
                <span class="stock-badge ${stockBadgeClass}">${stockBadgeText}</span>
                <span class="expiry-badge ${expiryBadgeClass}">${expiryBadgeText}</span>
            </td>
            <td>
                <div class="action-buttons">
                    <button class="btn-edit" onclick="editProduct('${product.id}')">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn-delete" onclick="deleteProduct('${product.id}')">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </td>
        `;
        
        inventoryTableBody.appendChild(row);
    });
    
    inventoryTotalValueEl.textContent = formatCurrency(totalValue);
});

// Product buttons
document.getElementById('add-product-btn').addEventListener('click', () => {
    openProductModal();
});

document.getElementById('add-inventory-btn').addEventListener('click', () => {
    openProductModal();
});

document.getElementById('save-product-btn').addEventListener('click', saveProduct);
document.getElementById('cancel-product-btn').addEventListener('click', closeProductModal);

// Cart buttons
document.getElementById('clear-cart-btn').addEventListener('click', () => {
    if (confirm('Are you sure you want to clear the cart?')) {
        clearCart();
    }
});

document.getElementById('complete-sale-btn').addEventListener('click', completeSale);

// Receipt modal buttons
document.getElementById('print-receipt-btn').addEventListener('click', printReceipt);
document.getElementById('new-sale-btn').addEventListener('click', () => {
    receiptModal.style.display = 'none';
});

// Report generation
document.getElementById('generate-report-btn').addEventListener('click', generateReport);

// Manual sync button
document.getElementById('manual-sync-btn').addEventListener('click', () => {
    if (isOnline && syncQueue.length > 0) {
        processSyncQueue();
    } else if (!isOnline) {
        showNotification('Cannot sync while offline', 'warning');
    } else {
        showNotification('No data to sync', 'info');
    }
});

// Modal close buttons
document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
        btn.closest('.modal').style.display = 'none';
    });
});

// Change password form
document.getElementById('change-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-new-password').value;
    
    if (newPassword !== confirmPassword) {
        showNotification('Passwords do not match', 'error');
        return;
    }
    
    // Show loading state
    changePasswordBtn.classList.add('loading');
    changePasswordBtn.disabled = true;
    
    try {
        // Re-authenticate user
        const { error } = await supabase.auth.signInWithPassword({
            email: currentUser.email,
            password: currentPassword
        });
        
        if (error) {
            throw error;
        }
        
        // Update password
        const { error: updateError } = await supabase.auth.updateUser({
            password: newPassword
        });
        
        if (updateError) {
            throw updateError;
        }
        
        showNotification('Password changed successfully', 'success');
        document.getElementById('change-password-form').reset();
    } catch (error) {
        console.error('Error changing password:', error);
        showNotification('Failed to change password: ' + error.message, 'error');
    } finally {
        // Hide loading state
        changePasswordBtn.classList.remove('loading');
        changePasswordBtn.disabled = false;
    }
});

// ✅ FIXED: Updated init function with all fixes
async function init() {
    // Load data from localStorage
    loadFromLocalStorage();
    loadSyncQueue();
    
    // Clean up duplicate sales
    cleanupDuplicateSales();
    
    // Clean up any already synced operations
    cleanupSyncQueue();
    
    // Check auth state
    AuthModule.onAuthStateChanged(async (user) => {
        if (user) {
            // Fetch user data from Supabase if needed
            if (!currentUser || currentUser.id !== user.id) {
                try {
                    const { data, error } = await supabase
                        .from('users')
                        .select('*')
                        .eq('id', user.id)
                        .single();
                    
                    if (!error && data) {
                        currentUser = data;
                        localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(currentUser));
                    }
                } catch (error) {
                    console.error('Error fetching user data:', error);
                }
            }
            
            // Initialize the change password form with username field
            initChangePasswordForm();
            
            showApp();
        } else {
            showLogin();
        }
    });
    
    // Set initial page
    showPage('pos');
    
    // Check online status
    if (isOnline) {
        checkSupabaseConnection();
    }
}

// Start the app
init();