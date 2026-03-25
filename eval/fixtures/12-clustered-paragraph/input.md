# Payment Processing

## How It Works

<!-- @comment{"id":"eval-12-c1","anchor":"Users enter their card details","text":"Specify that we use Stripe Elements for PCI-compliant card collection — card details never touch our servers.","author":"PM","timestamp":"2026-03-19T09:00:00Z"} -->Users enter their card details on the checkout page. <!-- @comment{"id":"eval-12-c2","anchor":"The system processes the payment","text":"Clarify that processing happens asynchronously via a webhook from Stripe, not synchronously during the request.","author":"Tech Lead","timestamp":"2026-03-19T09:01:00Z"} -->The system processes the payment and <!-- @comment{"id":"eval-12-c3","anchor":"sends a confirmation email","text":"Replace with: sends a confirmation email within 30 seconds using the SendGrid transactional email service.","author":"PM","timestamp":"2026-03-19T09:02:00Z"} -->sends a confirmation email to the user.

## Supported Payment Methods

We accept Visa, Mastercard, and American Express. Additional payment methods may be added in future releases.

## Refunds

Refunds are processed within 5-10 business days. Contact support for assistance with refund requests.
