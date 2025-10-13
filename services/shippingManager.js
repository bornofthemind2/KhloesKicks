import FedExService from './fedexService.js';
import UPSService from './upsService.js';
import winston from 'winston';

class ShippingManager {
  constructor(logger) {
    this.logger = logger || winston.createLogger({
      level: 'info',
      format: winston.format.json(),
      transports: [new winston.transports.Console()]
    });

    this.fedexService = new FedExService(this.logger);
    this.upsService = new UPSService(this.logger);
    this.defaultCarrier = process.env.DEFAULT_SHIPPING_CARRIER || 'fedex';
  }

  // Get available carriers
  getAvailableCarriers() {
    const carriers = [];
    
    if (this.fedexService.isConfigured()) {
      carriers.push({
        code: 'fedex',
        name: 'FedEx',
        configured: true
      });
    }
    
    if (this.upsService.isConfigured()) {
      carriers.push({
        code: 'ups',
        name: 'UPS',
        configured: true
      });
    }
    
    return carriers;
  }

  // Get service for specific carrier
  getCarrierService(carrier) {
    switch (carrier.toLowerCase()) {
      case 'fedex':
        return this.fedexService.isConfigured() ? this.fedexService : null;
      case 'ups':
        return this.upsService.isConfigured() ? this.upsService : null;
      default:
        return null;
    }
  }

  // Get rates from all available carriers
  async getAllRates(shipmentDetails) {
    const allRates = [];
    const carriers = this.getAvailableCarriers();

    for (const carrier of carriers) {
      try {
        const service = this.getCarrierService(carrier.code);
        if (service) {
          const rates = await service.getRates(shipmentDetails);
          allRates.push(...rates);
        }
      } catch (error) {
        this.logger.warn(`Failed to get rates from ${carrier.name}:`, error.message);
      }
    }

    // Sort by cost
    return allRates.sort((a, b) => a.cost - b.cost);
  }

  // Get rates from specific carrier
  async getCarrierRates(carrier, shipmentDetails) {
    const service = this.getCarrierService(carrier);
    if (!service) {
      throw new Error(`Carrier ${carrier} is not configured`);
    }

    return await service.getRates(shipmentDetails);
  }

  // Create shipping label
  async createShippingLabel(carrier, shipmentDetails) {
    const service = this.getCarrierService(carrier);
    if (!service) {
      throw new Error(`Carrier ${carrier} is not configured`);
    }

    return await service.createShippingLabel(shipmentDetails);
  }

  // Track package
  async trackPackage(carrier, trackingNumber) {
    const service = this.getCarrierService(carrier);
    if (!service) {
      throw new Error(`Carrier ${carrier} is not configured`);
    }

    return await service.trackPackage(trackingNumber);
  }

  // Auto-select best carrier and rate
  async getBestRate(shipmentDetails, preferences = {}) {
    const allRates = await this.getAllRates(shipmentDetails);
    
    if (allRates.length === 0) {
      throw new Error('No shipping rates available');
    }

    // Apply preferences
    let filteredRates = allRates;

    if (preferences.maxCost) {
      filteredRates = filteredRates.filter(rate => rate.cost <= preferences.maxCost);
    }

    if (preferences.maxTransitDays) {
      filteredRates = filteredRates.filter(rate => 
        !rate.transitTime || 
        rate.transitTime === 'Unknown' || 
        parseInt(rate.transitTime) <= preferences.maxTransitDays
      );
    }

    if (preferences.preferredCarrier) {
      const preferredRates = filteredRates.filter(rate => 
        rate.carrier === preferences.preferredCarrier.toLowerCase()
      );
      if (preferredRates.length > 0) {
        filteredRates = preferredRates;
      }
    }

    // Return the cheapest rate
    return filteredRates[0];
  }

  // Create shipment with auto-selected best rate
  async createOptimalShipment(shipmentDetails, preferences = {}) {
    try {
      const bestRate = await this.getBestRate(shipmentDetails, preferences);
      
      if (!bestRate) {
        throw new Error('No suitable shipping rates found');
      }

      this.logger.info('Creating shipment with optimal rate:', {
        carrier: bestRate.carrier,
        service: bestRate.serviceName,
        cost: bestRate.cost
      });

      return await this.createShippingLabel(bestRate.carrier, {
        ...shipmentDetails,
        serviceType: bestRate.service,
        serviceCode: bestRate.service
      });
    } catch (error) {
      this.logger.error('Failed to create optimal shipment:', error);
      throw error;
    }
  }

  // Validate shipping address
  validateAddress(address) {
    const required = ['name', 'line1', 'city', 'state', 'zip'];
    const missing = required.filter(field => !address[field]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required address fields: ${missing.join(', ')}`);
    }

    // Basic zip code validation
    if (address.country === 'US' || !address.country) {
      const zipRegex = /^\d{5}(-\d{4})?$/;
      if (!zipRegex.test(address.zip)) {
        throw new Error('Invalid US zip code format');
      }
    }

    return true;
  }

  // Build shipment details from order and addresses
  buildShipmentDetails(order, product, fromAddress, toAddress, options = {}) {
    this.validateAddress(fromAddress);
    this.validateAddress(toAddress);

    return {
      fromAddress,
      toAddress,
      weight: options.weight || this.estimateWeight(product),
      dimensions: options.dimensions || this.estimateDimensions(product),
      value: order.amount / 100, // Convert from cents
      itemDescription: `${product.brand} ${product.name}`.substring(0, 50),
      international: fromAddress.country !== toAddress.country,
      ...options
    };
  }

  // Estimate weight based on product type
  estimateWeight(product) {
    // Default sneaker weight in pounds
    let weight = 2.0;
    
    const brand = product.brand?.toLowerCase();
    const name = product.name?.toLowerCase() || '';
    
    // Adjust weight based on shoe type
    if (name.includes('boot') || name.includes('high')) {
      weight = 2.5;
    } else if (name.includes('running') || name.includes('lightweight')) {
      weight = 1.5;
    }
    
    return weight;
  }

  // Estimate dimensions based on product type
  estimateDimensions(product) {
    // Default sneaker box dimensions in inches
    return {
      length: 14,
      width: 10,
      height: 5
    };
  }

  // Get shipping service recommendations
  getServiceRecommendations(rates) {
    const recommendations = [];
    
    if (rates.length === 0) return recommendations;
    
    // Find cheapest
    const cheapest = rates.reduce((prev, curr) => prev.cost < curr.cost ? prev : curr);
    recommendations.push({
      type: 'cheapest',
      rate: cheapest,
      reason: 'Lowest cost option'
    });
    
    // Find fastest (if transit time available)
    const withTransitTime = rates.filter(rate => 
      rate.transitTime && 
      rate.transitTime !== 'Unknown' && 
      !isNaN(parseInt(rate.transitTime))
    );
    
    if (withTransitTime.length > 0) {
      const fastest = withTransitTime.reduce((prev, curr) => 
        parseInt(prev.transitTime) < parseInt(curr.transitTime) ? prev : curr
      );
      
      if (fastest !== cheapest) {
        recommendations.push({
          type: 'fastest',
          rate: fastest,
          reason: 'Fastest delivery time'
        });
      }
    }
    
    // Find best value (balance of cost and speed)
    if (withTransitTime.length > 0) {
      const bestValue = withTransitTime.reduce((prev, curr) => {
        const prevScore = prev.cost / parseInt(prev.transitTime);
        const currScore = curr.cost / parseInt(curr.transitTime);
        return prevScore < currScore ? prev : curr;
      });
      
      if (bestValue !== cheapest && bestValue !== recommendations.find(r => r.type === 'fastest')?.rate) {
        recommendations.push({
          type: 'best_value',
          rate: bestValue,
          reason: 'Best balance of cost and speed'
        });
      }
    }
    
    return recommendations;
  }
}

export default ShippingManager;