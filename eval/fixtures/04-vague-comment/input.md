# Notification System

## Overview

The notification system handles delivering messages to users across multiple channels.

## Email Notifications

<!-- @comment{"id":"eval-04-c1","anchor":"Emails are sent when important events occur","text":"Too vague — list the specific events that trigger emails (account creation, password reset, order confirmation, etc.) and what each email contains.","author":"PM","timestamp":"2026-03-20T12:00:00Z","resolved":false,"status":"open"} -->Emails are sent when important events occur. The system uses a template engine for formatting.

## Push Notifications

Push notifications are delivered via Firebase Cloud Messaging for mobile devices and Web Push API for browsers. Notifications include a title, body, and optional deep link.

## In-App Notifications

In-app notifications appear in the notification center. Users can mark them as read or dismiss them. Unread counts are shown in the navigation bar.
