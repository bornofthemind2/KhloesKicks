// Product Actions JavaScript Module
console.log('Product actions script loaded');

// Global variable to store product ID
let currentProductId = null;

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded, initializing product actions...');
    
    // Get product ID from the page (will be set by inline script)
    if (typeof window.productId !== 'undefined') {
        currentProductId = window.productId;
        console.log('Product ID set to:', currentProductId);
    }
});

// Show create auction modal
function showCreateAuctionModal() {
    console.log('showCreateAuctionModal called');
    const modal = document.getElementById('createAuctionModal');
    const overlay = document.getElementById('modalOverlay');
    
    console.log('Modal element:', modal);
    console.log('Overlay element:', overlay);
    
    if (modal && overlay) {
        modal.style.display = 'flex';
        overlay.style.display = 'block';
        document.body.style.overflow = 'hidden';
        console.log('Modal should now be visible');
    } else {
        console.error('Modal or overlay element not found!');
        alert('Error: Could not find modal elements. Please refresh the page.');
    }
}

// Close create auction modal
function closeCreateAuctionModal() {
    console.log('closeCreateAuctionModal called');
    const modal = document.getElementById('createAuctionModal');
    const overlay = document.getElementById('modalOverlay');
    
    if (modal && overlay) {
        modal.style.display = 'none';
        overlay.style.display = 'none';
        document.body.style.overflow = 'auto';
    }
}

// Create auction
async function createAuction() {
    console.log('createAuction called');
    const form = document.getElementById('createAuctionForm');
    if (!form) {
        console.error('Create auction form not found');
        alert('Error: Form not found');
        return;
    }
    
    const formData = new FormData(form);
    
    const auctionData = {
        product_id: formData.get('product_id'),
        starting_bid: parseInt(formData.get('starting_bid')),
        duration: parseInt(formData.get('duration')),
        reserve_price: formData.get('reserve_price') ? parseInt(formData.get('reserve_price')) : null
    };
    
    console.log('Auction data:', auctionData);
    
    if (!auctionData.starting_bid || auctionData.starting_bid < 1) {
        alert('Please enter a valid starting bid');
        return;
    }
    
    try {
        const response = await fetch('/api/auctions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(auctionData)
        });
        
        console.log('Response status:', response.status);
        const data = await response.json();
        console.log('Response data:', data);
        
        if (data.success) {
            alert('Auction created successfully!');
            window.location.reload();
        } else {
            alert('Error: ' + (data.error || 'Failed to create auction'));
        }
    } catch (e) {
        console.error('Error creating auction:', e);
        alert('Failed to create auction: ' + e.message);
    }
}

// Confirm and end auction
function confirmEndAuction(auctionId) {
    console.log('confirmEndAuction called with auctionId:', auctionId);
    if (!confirm('Are you sure you want to end this auction? This action cannot be undone.')) {
        return;
    }
    
    endAuction(auctionId);
}

// End auction
async function endAuction(auctionId) {
    console.log('endAuction called with auctionId:', auctionId);
    try {
        const response = await fetch(`/api/auctions/${auctionId}/end`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        console.log('End auction response status:', response.status);
        const data = await response.json();
        console.log('End auction response data:', data);
        
        if (data.success) {
            alert('Auction ended successfully!');
            window.location.reload();
        } else {
            alert('Error: ' + (data.error || 'Failed to end auction'));
        }
    } catch (e) {
        console.error('Error ending auction:', e);
        alert('Failed to end auction: ' + e.message);
    }
}

// Confirm sold out
function confirmSoldOut(productId) {
    console.log('confirmSoldOut called with productId:', productId);
    if (!confirm('Mark this product as sold out? This will remove it from all active listings.')) {
        return;
    }
    
    markSoldOut(productId);
}

// Mark product as sold out
async function markSoldOut(productId) {
    console.log('markSoldOut called with productId:', productId);
    try {
        const response = await fetch(`/api/products/${productId}/sold-out`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        console.log('Sold out response status:', response.status);
        const data = await response.json();
        console.log('Sold out response data:', data);
        
        if (data.success) {
            alert('Product marked as sold out!');
            window.location.href = '/products';
        } else {
            alert('Error: ' + (data.error || 'Failed to mark as sold out'));
        }
    } catch (e) {
        console.error('Error marking as sold out:', e);
        alert('Failed to mark as sold out: ' + e.message);
    }
}

// Toggle product availability
async function toggleAvailability(productId) {
    console.log('toggleAvailability called with productId:', productId);
    try {
        const response = await fetch(`/api/products/${productId}/toggle-availability`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        console.log('Toggle availability response status:', response.status);
        const data = await response.json();
        console.log('Toggle availability response data:', data);
        
        if (data.success) {
            alert(`Product availability updated: ${data.available ? 'Available' : 'Unavailable'}`);
            window.location.reload();
        } else {
            alert('Error: ' + (data.error || 'Failed to toggle availability'));
        }
    } catch (e) {
        console.error('Error toggling availability:', e);
        alert('Failed to toggle availability: ' + e.message);
    }
}

// Make functions globally available
window.showCreateAuctionModal = showCreateAuctionModal;
window.closeCreateAuctionModal = closeCreateAuctionModal;
window.createAuction = createAuction;
window.confirmEndAuction = confirmEndAuction;
window.endAuction = endAuction;
window.confirmSoldOut = confirmSoldOut;
window.markSoldOut = markSoldOut;
window.toggleAvailability = toggleAvailability;

console.log('All product action functions are now globally available');