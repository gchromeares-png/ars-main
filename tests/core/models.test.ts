import { TaskState, Task, Shop, Product, ProductCriteria, Cart, CartItem, CheckoutResult } from '../../src/core/models';

describe('Core Models', () => {
  it('should create a task with correct structure', () => {
    const task: Task = {
      id: '1',
      config: {
        id: '1',
        name: 'Test Task'
      },
      state: TaskState.CREATED,
      createdAt: new Date(),
      updatedAt: new Date(),
      retries: 0,
      maxRetries: 3
    };

    expect(task.id).toBe('1');
    expect(task.state).toBe(TaskState.CREATED);
    expect(task.retries).toBe(0);
    expect(task.maxRetries).toBe(3);
  });

  it('should create a shop with correct structure', () => {
    const shop: Shop = {
      id: 'shop1',
      name: 'Test Shop',
      url: 'https://test-shop.com',
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    expect(shop.id).toBe('shop1');
    expect(shop.name).toBe('Test Shop');
    expect(shop.url).toBe('https://test-shop.com');
    expect(shop.enabled).toBe(true);
  });

  it('should create a product with correct structure', () => {
    const product: Product = {
      id: 'product1',
      shopId: 'shop1',
      title: 'Test Product',
      price: 99.99,
      currency: 'EUR',
      url: 'https://test-shop.com/product/1',
      inStock: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    expect(product.id).toBe('product1');
    expect(product.title).toBe('Test Product');
    expect(product.price).toBe(99.99);
    expect(product.inStock).toBe(true);
  });

  it('should create a product criteria', () => {
    const criteria: ProductCriteria = {
      searchTerm: 'laptop',
      minPrice: 500,
      maxPrice: 2000,
      brand: 'Dell',
      category: 'Computers',
      inStockOnly: true,
      sortBy: 'price',
      sortOrder: 'asc'
    };

    expect(criteria.searchTerm).toBe('laptop');
    expect(criteria.minPrice).toBe(500);
    expect(criteria.brand).toBe('Dell');
  });

  it('should create a cart with items', () => {
    const item: CartItem = {
      id: 'item1',
      productId: 'product1',
      quantity: 2,
      price: 99.99,
      currency: 'EUR',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const cart: Cart = {
      id: 'cart1',
      shopId: 'shop1',
      items: [item],
      totalAmount: 199.98,
      currency: 'EUR',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    expect(cart.id).toBe('cart1');
    expect(cart.items.length).toBe(1);
    expect(cart.totalAmount).toBe(199.98);
  });

  it('should create a checkout result', () => {
    const result: CheckoutResult = {
      success: true,
      orderId: 'order123',
      transactionId: 'txn456',
      paymentMethod: 'credit_card',
      timestamp: new Date()
    };

    expect(result.success).toBe(true);
    expect(result.orderId).toBe('order123');
  });
});
