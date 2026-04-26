# Checkout Sequence

The checkout flow is a synchronous client-server interaction with one async fan-out at the end.

```mermaid
sequenceDiagram
  participant U as User Browser
  participant API as API Gateway
  participant Order as Order Service
  participant Pay as Payment Service

  U->>API: POST /checkout
  API->>Order: CreateOrder(cart)
  Order->>Pay: ChargeCard(amount)
  Pay-->>Order: payment confirmed
  Order-->>API: order id
  API-->>U: 201 Created
```

<!-- @comment{"id":"eval-15-c1","anchor":"ChargeCard(amount)","text":"Add a missing step: before Order calls Pay, it should reserve inventory. Add a new participant 'Inv as Inventory Service' and a 'ReserveItems(items)' message from Order to Inv (with a synchronous reply) before the ChargeCard line.","author":"PM","timestamp":"2026-04-26T10:05:00Z"} -->

After payment confirms the order is committed and a confirmation event is published.
