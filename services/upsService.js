import fetch from 'node-fetch';
import winston from 'winston';

class UPSService {
  constructor(logger) {
    this.logger = logger || winston.createLogger({
      level: 'info',
      format: winston.format.json(),
      transports: [new winston.transports.Console()]
    });

    this.clientId = process.env.UPS_CLIENT_ID;
    this.clientSecret = process.env.UPS_CLIENT_SECRET;
    this.accountNumber = process.env.UPS_ACCOUNT_NUMBER;
    this.accessLicenseNumber = process.env.UPS_ACCESS_LICENSE_NUMBER;
    this.baseUrl = process.env.UPS_BASE_URL || 'https://wwwcie.ups.com';
    
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  // Authenticate with UPS API and get access token
  async authenticate() {
    try {
      if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
        return this.accessToken;
      }

      const response = await fetch(`${this.baseUrl}/security/v1/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-merchant-id': this.clientId,
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret
        })
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`UPS authentication failed: ${error}`);
      }

      const data = await response.json();
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000; // Subtract 1 minute for safety

      this.logger.info('UPS authentication successful');
      return this.accessToken;
    } catch (error) {
      this.logger.error('UPS authentication error:', error);
      throw error;
    }
  }

  // Get shipping rates
  async getRates(shipmentDetails) {
    try {
      const token = await this.authenticate();

      const rateRequest = {
        RateRequest: {
          Request: {
            SubVersion: '1801',
            RequestOption: 'Shop',
            TransactionReference: {
              CustomerContext: 'Rate Shopping'
            }
          },
          Shipment: {
            Shipper: {
              Name: shipmentDetails.fromAddress.name || 'Shipper',
              ShipperNumber: this.accountNumber,
              Address: {
                AddressLine: [shipmentDetails.fromAddress.line1],
                City: shipmentDetails.fromAddress.city,
                StateProvinceCode: shipmentDetails.fromAddress.state,
                PostalCode: shipmentDetails.fromAddress.zip,
                CountryCode: shipmentDetails.fromAddress.country || 'US'
              }
            },
            ShipTo: {
              Name: shipmentDetails.toAddress.name,
              Address: {
                AddressLine: [shipmentDetails.toAddress.line1],
                City: shipmentDetails.toAddress.city,
                StateProvinceCode: shipmentDetails.toAddress.state,
                PostalCode: shipmentDetails.toAddress.zip,
                CountryCode: shipmentDetails.toAddress.country || 'US'
              }
            },
            ShipFrom: {
              Name: shipmentDetails.fromAddress.name || 'Shipper',
              Address: {
                AddressLine: [shipmentDetails.fromAddress.line1],
                City: shipmentDetails.fromAddress.city,
                StateProvinceCode: shipmentDetails.fromAddress.state,
                PostalCode: shipmentDetails.fromAddress.zip,
                CountryCode: shipmentDetails.fromAddress.country || 'US'
              }
            },
            Package: [{
              PackagingType: {
                Code: '02', // Customer Supplied Package
                Description: 'Package'
              },
              Dimensions: {
                UnitOfMeasurement: {
                  Code: 'IN'
                },
                Length: (shipmentDetails.dimensions?.length || 12).toString(),
                Width: (shipmentDetails.dimensions?.width || 8).toString(),
                Height: (shipmentDetails.dimensions?.height || 6).toString()
              },
              PackageWeight: {
                UnitOfMeasurement: {
                  Code: 'LBS'
                },
                Weight: (shipmentDetails.weight || 2).toString()
              }
            }]
          }
        }
      };

      const response = await fetch(`${this.baseUrl}/api/rating/v1/Rate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'transId': Date.now().toString(),
          'transactionSrc': 'sneaker-auction'
        },
        body: JSON.stringify(rateRequest)
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`UPS rate request failed: ${error}`);
      }

      const data = await response.json();
      return this.parseRateResponse(data);
    } catch (error) {
      this.logger.error('UPS rate calculation error:', error);
      throw error;
    }
  }

  // Create shipping label
  async createShippingLabel(shipmentDetails) {
    try {
      const token = await this.authenticate();

      const shipRequest = {
        ShipmentRequest: {
          Request: {
            SubVersion: '1801',
            RequestOption: 'nonvalidate',
            TransactionReference: {
              CustomerContext: 'Ship Request'
            }
          },
          Shipment: {
            Description: 'Sneaker Shipment',
            Shipper: {
              Name: shipmentDetails.fromAddress.name || 'Shipper',
              AttentionName: shipmentDetails.fromAddress.name || 'Shipper',
              ShipperNumber: this.accountNumber,
              Address: {
                AddressLine: [shipmentDetails.fromAddress.line1],
                City: shipmentDetails.fromAddress.city,
                StateProvinceCode: shipmentDetails.fromAddress.state,
                PostalCode: shipmentDetails.fromAddress.zip,
                CountryCode: shipmentDetails.fromAddress.country || 'US'
              },
              Phone: {
                Number: shipmentDetails.fromAddress.phone || '5551234567'
              }
            },
            ShipTo: {
              Name: shipmentDetails.toAddress.name,
              AttentionName: shipmentDetails.toAddress.name,
              Address: {
                AddressLine: [shipmentDetails.toAddress.line1],
                City: shipmentDetails.toAddress.city,
                StateProvinceCode: shipmentDetails.toAddress.state,
                PostalCode: shipmentDetails.toAddress.zip,
                CountryCode: shipmentDetails.toAddress.country || 'US'
              },
              Phone: {
                Number: shipmentDetails.toAddress.phone || '5551234567'
              }
            },
            ShipFrom: {
              Name: shipmentDetails.fromAddress.name || 'Shipper',
              AttentionName: shipmentDetails.fromAddress.name || 'Shipper',
              Address: {
                AddressLine: [shipmentDetails.fromAddress.line1],
                City: shipmentDetails.fromAddress.city,
                StateProvinceCode: shipmentDetails.fromAddress.state,
                PostalCode: shipmentDetails.fromAddress.zip,
                CountryCode: shipmentDetails.fromAddress.country || 'US'
              },
              Phone: {
                Number: shipmentDetails.fromAddress.phone || '5551234567'
              }
            },
            PaymentInformation: {
              ShipmentCharge: {
                Type: '01', // Transportation
                BillShipper: {
                  AccountNumber: this.accountNumber
                }
              }
            },
            Service: {
              Code: shipmentDetails.serviceCode || '03', // Ground
              Description: shipmentDetails.serviceDescription || 'UPS Ground'
            },
            Package: [{
              Description: shipmentDetails.itemDescription || 'Sneakers',
              Packaging: {
                Code: '02', // Customer Supplied Package
              },
              Dimensions: {
                UnitOfMeasurement: {
                  Code: 'IN'
                },
                Length: (shipmentDetails.dimensions?.length || 12).toString(),
                Width: (shipmentDetails.dimensions?.width || 8).toString(),
                Height: (shipmentDetails.dimensions?.height || 6).toString()
              },
              PackageWeight: {
                UnitOfMeasurement: {
                  Code: 'LBS'
                },
                Weight: (shipmentDetails.weight || 2).toString()
              }
            }]
          },
          LabelSpecification: {
            LabelImageFormat: {
              Code: 'PDF'
            },
            HTTPUserAgent: 'Mozilla/4.0'
          }
        }
      };

      const response = await fetch(`${this.baseUrl}/api/shipments/v1/ship`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'transId': Date.now().toString(),
          'transactionSrc': 'sneaker-auction'
        },
        body: JSON.stringify(shipRequest)
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`UPS shipment creation failed: ${error}`);
      }

      const data = await response.json();
      return this.parseShipmentResponse(data);
    } catch (error) {
      this.logger.error('UPS shipment creation error:', error);
      throw error;
    }
  }

  // Track package
  async trackPackage(trackingNumber) {
    try {
      const token = await this.authenticate();

      const response = await fetch(`${this.baseUrl}/api/track/v1/details/${trackingNumber}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'transId': Date.now().toString(),
          'transactionSrc': 'sneaker-auction'
        }
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`UPS tracking failed: ${error}`);
      }

      const data = await response.json();
      return this.parseTrackingResponse(data);
    } catch (error) {
      this.logger.error('UPS tracking error:', error);
      throw error;
    }
  }

  // Parse rate response
  parseRateResponse(response) {
    const rates = [];
    
    if (response.RateResponse?.RatedShipment) {
      const ratedShipments = Array.isArray(response.RateResponse.RatedShipment) 
        ? response.RateResponse.RatedShipment 
        : [response.RateResponse.RatedShipment];

      for (const rate of ratedShipments) {
        rates.push({
          carrier: 'ups',
          service: rate.Service?.Code,
          serviceName: this.getServiceName(rate.Service?.Code),
          cost: parseFloat(rate.TotalCharges?.MonetaryValue || 0),
          currency: rate.TotalCharges?.CurrencyCode || 'USD',
          transitTime: rate.GuaranteedDelivery?.BusinessDaysInTransit || 'Unknown',
          deliveryDate: rate.GuaranteedDelivery?.DeliveryByTime || null
        });
      }
    }

    return rates;
  }

  // Parse shipment response
  parseShipmentResponse(response) {
    const shipmentResults = response.ShipmentResponse?.ShipmentResults;
    
    if (!shipmentResults) {
      throw new Error('Invalid UPS shipment response');
    }

    const packageResult = shipmentResults.PackageResults?.[0] || shipmentResults.PackageResults;

    return {
      carrier: 'ups',
      trackingNumber: packageResult?.TrackingNumber,
      labelUrl: packageResult?.ShippingLabel?.GraphicImage, // Base64 encoded
      cost: parseFloat(shipmentResults.ShipmentCharges?.TotalCharges?.MonetaryValue || 0),
      currency: shipmentResults.ShipmentCharges?.TotalCharges?.CurrencyCode || 'USD'
    };
  }

  // Parse tracking response
  parseTrackingResponse(response) {
    const trackResponse = response.trackResponse;
    
    if (!trackResponse?.shipment?.[0]) {
      return {
        carrier: 'ups',
        trackingNumber: null,
        status: 'Not Found',
        statusDescription: 'Tracking information not available',
        events: []
      };
    }

    const shipment = trackResponse.shipment[0];
    const package_ = shipment.package?.[0];

    const events = (package_?.activity || []).map(activity => ({
      date: activity.date,
      time: activity.time,
      description: activity.status?.description || 'Package activity',
      location: `${activity.location?.address?.city || ''}, ${activity.location?.address?.stateProvinceCode || ''}`.trim()
    }));

    return {
      carrier: 'ups',
      trackingNumber: package_?.trackingNumber,
      status: package_?.currentStatus?.code || 'Unknown',
      statusDescription: package_?.currentStatus?.description || 'No status available',
      estimatedDelivery: package_?.deliveryDate?.[0]?.date,
      events: events
    };
  }

  // Get friendly service name
  getServiceName(serviceCode) {
    const services = {
      '01': 'UPS Next Day Air',
      '02': 'UPS 2nd Day Air',
      '03': 'UPS Ground',
      '07': 'UPS Worldwide Express',
      '08': 'UPS Worldwide Expedited',
      '11': 'UPS Standard',
      '12': 'UPS 3 Day Select',
      '13': 'UPS Next Day Air Saver',
      '14': 'UPS Next Day Air Early A.M.',
      '54': 'UPS Worldwide Express Plus'
    };
    
    return services[serviceCode] || `UPS Service ${serviceCode}`;
  }

  // Check if service is available
  isConfigured() {
    return !!(this.clientId && this.clientSecret && this.accountNumber && this.accessLicenseNumber);
  }
}

export default UPSService;