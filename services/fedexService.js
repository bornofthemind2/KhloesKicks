import fetch from 'node-fetch';
import winston from 'winston';

class FedExService {
  constructor(logger) {
    this.logger = logger || winston.createLogger({
      level: 'info',
      format: winston.format.json(),
      transports: [new winston.transports.Console()]
    });

    this.clientId = process.env.FEDEX_CLIENT_ID;
    this.clientSecret = process.env.FEDEX_CLIENT_SECRET;
    this.accountNumber = process.env.FEDEX_ACCOUNT_NUMBER;
    this.meterNumber = process.env.FEDEX_METER_NUMBER;
    this.baseUrl = process.env.FEDEX_BASE_URL || 'https://apis-sandbox.fedex.com';
    
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  // Authenticate with FedEx API and get access token
  async authenticate() {
    try {
      if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
        return this.accessToken;
      }

      const response = await fetch(`${this.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret
        })
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`FedEx authentication failed: ${error}`);
      }

      const data = await response.json();
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000; // Subtract 1 minute for safety

      this.logger.info('FedEx authentication successful');
      return this.accessToken;
    } catch (error) {
      this.logger.error('FedEx authentication error:', error);
      throw error;
    }
  }

  // Get shipping rates
  async getRates(shipmentDetails) {
    try {
      const token = await this.authenticate();

      const rateRequest = {
        accountNumber: {
          value: this.accountNumber
        },
        requestedShipment: {
          shipper: {
            address: {
              streetLines: [shipmentDetails.fromAddress.line1],
              city: shipmentDetails.fromAddress.city,
              stateOrProvinceCode: shipmentDetails.fromAddress.state,
              postalCode: shipmentDetails.fromAddress.zip,
              countryCode: shipmentDetails.fromAddress.country || 'US'
            }
          },
          recipients: [{
            address: {
              streetLines: [shipmentDetails.toAddress.line1],
              city: shipmentDetails.toAddress.city,
              stateOrProvinceCode: shipmentDetails.toAddress.state,
              postalCode: shipmentDetails.toAddress.zip,
              countryCode: shipmentDetails.toAddress.country || 'US'
            }
          }],
          pickupType: 'USE_SCHEDULED_PICKUP',
          serviceType: shipmentDetails.serviceType || 'FEDEX_GROUND',
          packagingType: 'YOUR_PACKAGING',
          requestedPackageLineItems: [{
            weight: {
              units: 'LB',
              value: shipmentDetails.weight || 2
            },
            dimensions: {
              length: shipmentDetails.dimensions?.length || 12,
              width: shipmentDetails.dimensions?.width || 8,
              height: shipmentDetails.dimensions?.height || 6,
              units: 'IN'
            }
          }]
        }
      };

      const response = await fetch(`${this.baseUrl}/rate/v1/rates/quotes`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-locale': 'en_US'
        },
        body: JSON.stringify(rateRequest)
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`FedEx rate request failed: ${error}`);
      }

      const data = await response.json();
      return this.parseRateResponse(data);
    } catch (error) {
      this.logger.error('FedEx rate calculation error:', error);
      throw error;
    }
  }

  // Create shipping label
  async createShippingLabel(shipmentDetails) {
    try {
      const token = await this.authenticate();

      const shipRequest = {
        labelResponseOptions: 'URL_ONLY',
        requestedShipment: {
          shipper: {
            contact: {
              personName: shipmentDetails.fromAddress.name,
              phoneNumber: shipmentDetails.fromAddress.phone || '5551234567'
            },
            address: {
              streetLines: [
                shipmentDetails.fromAddress.line1,
                ...(shipmentDetails.fromAddress.line2 ? [shipmentDetails.fromAddress.line2] : [])
              ],
              city: shipmentDetails.fromAddress.city,
              stateOrProvinceCode: shipmentDetails.fromAddress.state,
              postalCode: shipmentDetails.fromAddress.zip,
              countryCode: shipmentDetails.fromAddress.country || 'US'
            }
          },
          recipients: [{
            contact: {
              personName: shipmentDetails.toAddress.name,
              phoneNumber: shipmentDetails.toAddress.phone || '5551234567'
            },
            address: {
              streetLines: [
                shipmentDetails.toAddress.line1,
                ...(shipmentDetails.toAddress.line2 ? [shipmentDetails.toAddress.line2] : [])
              ],
              city: shipmentDetails.toAddress.city,
              stateOrProvinceCode: shipmentDetails.toAddress.state,
              postalCode: shipmentDetails.toAddress.zip,
              countryCode: shipmentDetails.toAddress.country || 'US'
            }
          }],
          serviceType: shipmentDetails.serviceType || 'FEDEX_GROUND',
          packagingType: 'YOUR_PACKAGING',
          shipDatestamp: new Date().toISOString().slice(0, 10),
          requestedPackageLineItems: [{
            weight: {
              units: 'LB',
              value: shipmentDetails.weight || 2
            },
            dimensions: {
              length: shipmentDetails.dimensions?.length || 12,
              width: shipmentDetails.dimensions?.width || 8,
              height: shipmentDetails.dimensions?.height || 6,
              units: 'IN'
            }
          }],
          customsClearanceDetail: shipmentDetails.international ? {
            dutiesPayment: {
              paymentType: 'SENDER'
            },
            commodities: [{
              description: shipmentDetails.itemDescription || 'Sneakers',
              quantity: 1,
              quantityUnits: 'PCS',
              weight: {
                units: 'LB',
                value: shipmentDetails.weight || 2
              },
              customsValue: {
                amount: shipmentDetails.value || 100,
                currency: 'USD'
              }
            }]
          } : undefined
        },
        accountNumber: {
          value: this.accountNumber
        }
      };

      const response = await fetch(`${this.baseUrl}/ship/v1/shipments`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-locale': 'en_US'
        },
        body: JSON.stringify(shipRequest)
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`FedEx shipment creation failed: ${error}`);
      }

      const data = await response.json();
      return this.parseShipmentResponse(data);
    } catch (error) {
      this.logger.error('FedEx shipment creation error:', error);
      throw error;
    }
  }

  // Track package
  async trackPackage(trackingNumber) {
    try {
      const token = await this.authenticate();

      const trackRequest = {
        includeDetailedScans: true,
        trackingInfo: [{
          trackingNumberInfo: {
            trackingNumber: trackingNumber
          }
        }]
      };

      const response = await fetch(`${this.baseUrl}/track/v1/trackingnumbers`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-locale': 'en_US'
        },
        body: JSON.stringify(trackRequest)
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`FedEx tracking failed: ${error}`);
      }

      const data = await response.json();
      return this.parseTrackingResponse(data);
    } catch (error) {
      this.logger.error('FedEx tracking error:', error);
      throw error;
    }
  }

  // Parse rate response
  parseRateResponse(response) {
    const rates = [];
    
    if (response.output?.rateReplyDetails) {
      for (const rate of response.output.rateReplyDetails) {
        rates.push({
          carrier: 'fedex',
          service: rate.serviceType,
          serviceName: this.getServiceName(rate.serviceType),
          cost: rate.ratedShipmentDetails?.[0]?.totalNetCharge || 0,
          currency: rate.ratedShipmentDetails?.[0]?.currency || 'USD',
          transitTime: rate.commit?.dateDetail?.dayOfWeek || 'Unknown',
          deliveryDate: rate.commit?.dateDetail?.datetimeOffset || null
        });
      }
    }

    return rates;
  }

  // Parse shipment response
  parseShipmentResponse(response) {
    const output = response.output?.transactionShipments?.[0];
    
    if (!output) {
      throw new Error('Invalid FedEx shipment response');
    }

    return {
      carrier: 'fedex',
      trackingNumber: output.masterTrackingNumber,
      labelUrl: output.pieceResponses?.[0]?.packageDocuments?.[0]?.url,
      cost: output.shipmentRating?.totalNetCharge || 0,
      currency: output.shipmentRating?.currency || 'USD'
    };
  }

  // Parse tracking response
  parseTrackingResponse(response) {
    const trackInfo = response.output?.completeTrackResults?.[0]?.trackResults?.[0];
    
    if (!trackInfo) {
      return {
        carrier: 'fedex',
        trackingNumber: null,
        status: 'Not Found',
        statusDescription: 'Tracking information not available',
        events: []
      };
    }

    const events = (trackInfo.scanEvents || []).map(event => ({
      date: event.date,
      time: event.time,
      description: event.eventDescription,
      location: `${event.scanLocation?.city || ''}, ${event.scanLocation?.stateOrProvinceCode || ''}`.trim()
    }));

    return {
      carrier: 'fedex',
      trackingNumber: trackInfo.trackingNumberInfo?.trackingNumber,
      status: trackInfo.latestStatusDetail?.code || 'Unknown',
      statusDescription: trackInfo.latestStatusDetail?.description || 'No status available',
      estimatedDelivery: trackInfo.dateAndTimes?.find(dt => dt.type === 'ESTIMATED_DELIVERY')?.dateTime,
      events: events
    };
  }

  // Get friendly service name
  getServiceName(serviceType) {
    const services = {
      'FEDEX_GROUND': 'FedEx Ground',
      'FEDEX_EXPRESS_SAVER': 'FedEx Express Saver',
      'FEDEX_2_DAY': 'FedEx 2Day',
      'STANDARD_OVERNIGHT': 'FedEx Standard Overnight',
      'PRIORITY_OVERNIGHT': 'FedEx Priority Overnight',
      'FIRST_OVERNIGHT': 'FedEx First Overnight'
    };
    
    return services[serviceType] || serviceType;
  }

  // Check if service is available
  isConfigured() {
    return !!(this.clientId && this.clientSecret && this.accountNumber && this.meterNumber);
  }
}

export default FedExService;