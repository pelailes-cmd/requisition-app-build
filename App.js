import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import * as FileSystem from "expo-file-system/legacy";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Feather } from "@expo/vector-icons";

const ROLES = [
  {
    key: "Manager",
    icon: "briefcase",
    description: "Full control over requisitions and approvals."
  },
  {
    key: "Procurement",
    icon: "truck",
    description: "Update fulfillment and purchasing progress."
  },
  {
    key: "Engineer",
    icon: "tool",
    description: "Create and maintain technical requests."
  },
  {
    key: "Staff",
    icon: "users",
    description: "Create and update item requests."
  }
];

const PERMISSIONS = {
  Manager: { add: true, edit: true, remove: true, status: true },
  Procurement: { add: false, edit: false, remove: false, status: true },
  Engineer: { add: true, edit: true, remove: true, status: false },
  Staff: { add: true, edit: true, remove: false, status: false }
};

const BASE_STATUS_OPTIONS = ["Draft", "Submitted", "Review", "Approved", "Ordered", "Received", "Rejected"];
const PROCUREMENT_STATUS_OPTIONS = ["Purchased", "Delivered", "On-Bidding", "For Quotation", "Under Cost Control"];
const STATUS_OPTIONS = [...BASE_STATUS_OPTIONS, ...PROCUREMENT_STATUS_OPTIONS];
const PRIORITY_OPTIONS = ["Low", "Normal", "High", "Urgent"];
const DELIVERY_CONFIRMATION_OPTIONS = ["Confirmed", "With Discrepancy"];

const INITIAL_ITEMS = [
  {
    id: "REQ-1042",
    projectId: "sample",
    item: "Safety helmets",
    category: "PPE",
    quantity: "36",
    neededDate: "2026-05-14",
    priority: "High",
    requestedBy: "Site Team A",
    chargeTo: "North Wing Project",
    status: "Submitted",
    procurementStatus: "",
    notes: "For new contractors at the north wing."
  },
  {
    id: "REQ-1043",
    projectId: "sample",
    item: "Rotary hammer drill",
    category: "Equipment",
    quantity: "2",
    neededDate: "2026-05-18",
    priority: "Normal",
    requestedBy: "Structural Team",
    chargeTo: "Structural Works",
    status: "Review",
    procurementStatus: "",
    notes: "Prefer cordless units with extra batteries."
  },
  {
    id: "REQ-1044",
    projectId: "sample",
    item: "PVC conduit 25mm",
    category: "Material",
    quantity: "120",
    neededDate: "2026-05-20",
    priority: "Low",
    requestedBy: "Electrical Team",
    chargeTo: "Level 3 Electrical",
    status: "Ordered",
    procurementStatus: "",
    notes: "For level 3 rough-in works."
  }
];

const INITIAL_PROJECTS = [
  {
    id: "sample",
    title: "Sample",
    director: "",
    startDate: "",
    endDate: "",
    managers: "Pel Martine Ailes",
    engineers: "",
    projectCosts: "",
    contractors: "",
    locationSite: "",
    projectCode: "SAMPLE"
  }
];

const EMPTY_FORM = {
  item: "",
  category: "",
  quantity: "",
  neededDate: "",
  priority: "Normal",
  requestedBy: "",
  chargeTo: "",
  notes: ""
};

const EMPTY_PROJECT_FORM = {
  title: "",
  director: "",
  startDate: "",
  endDate: "",
  managers: "",
  engineers: "",
  projectCosts: "",
  contractors: "",
  locationSite: "",
  projectCode: ""
};

const MANAGER_EMAIL = "afhinzz.ailes@gmail.com";
const OTP_API_URL = process.env.EXPO_PUBLIC_API_URL || "https://requisition-app-api.onrender.com";

const INITIAL_ACCOUNTS = [
  {
    username: "pelailes",
    password: "pel291999",
    email: MANAGER_EMAIL,
    firstName: "Pel Martine",
    middleName: "Aguilar",
    lastName: "Ailes",
    department: "Management",
    trade: "Management",
    head: "Manager",
    role: "Manager"
  }
];

const EMPTY_SIGNUP_FORM = {
  username: "",
  password: "",
  email: "",
  firstName: "",
  middleName: "",
  lastName: "",
  department: "",
  trade: "",
  head: "",
  role: "Staff",
  managerUsername: "",
  code: ""
};

const OTP_REQUEST_COOLDOWN_SECONDS = 60;

export default function App() {
  const [selectedRole, setSelectedRole] = useState("Staff");
  const [user, setUser] = useState(null);
  const [accounts, setAccounts] = useState(INITIAL_ACCOUNTS);
  const [authMode, setAuthMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoginLoading, setIsLoginLoading] = useState(false);
  const [isOtpRequesting, setIsOtpRequesting] = useState(false);
  const [otpCooldownSeconds, setOtpCooldownSeconds] = useState(0);
  const [signupForm, setSignupForm] = useState(EMPTY_SIGNUP_FORM);
  const [projects, setProjects] = useState(INITIAL_PROJECTS);
  const [selectedProjectId, setSelectedProjectId] = useState("sample");
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
  const [isProjectFormOpen, setIsProjectFormOpen] = useState(false);
  const [projectForm, setProjectForm] = useState(EMPTY_PROJECT_FORM);
  const [items, setItems] = useState(INITIAL_ITEMS);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [sortOrder, setSortOrder] = useState("Latest");
  const [viewMode, setViewMode] = useState("Full");
  const [isDisplayMenuOpen, setIsDisplayMenuOpen] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [selectedRequisitionId, setSelectedRequisitionId] = useState(null);
  const [editingItem, setEditingItem] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const permissions = selectedRole ? PERMISSIONS[selectedRole] : {};
  const canConfirmDelivery = user?.role === "Engineer" || user?.role === "Staff";
  const selectedProject = projects.find((project) => project.id === selectedProjectId) || projects[0] || INITIAL_PROJECTS[0];

  const managerAccounts = useMemo(() => {
    return accounts.filter((account) => account.role === "Manager");
  }, [accounts]);

  const statusOptionsForUser = useMemo(() => {
    if (user?.role === "Procurement") {
      return PROCUREMENT_STATUS_OPTIONS;
    }

    return BASE_STATUS_OPTIONS;
  }, [user]);

  useEffect(() => {
    loadAccounts();
    loadProjects();
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      loadItems(selectedProjectId);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (otpCooldownSeconds <= 0) {
      return undefined;
    }

    const timer = setInterval(() => {
      setOtpCooldownSeconds((current) => Math.max(current - 1, 0));
    }, 1000);

    return () => clearInterval(timer);
  }, [otpCooldownSeconds]);

  const filteredItems = useMemo(() => {
    const filtered = items.filter((item) => {
      const searchable = `${item.item} ${item.category} ${item.requestedBy} ${item.status} ${item.procurementStatus} ${item.deliveryConfirmation} ${item.deliveryRemarks}`.toLowerCase();
      const matchesQuery = searchable.includes(query.trim().toLowerCase());
      const matchesStatus = statusFilter === "All" || item.status === statusFilter || item.procurementStatus === statusFilter;
      return matchesQuery && matchesStatus;
    });

    return [...filtered].sort((first, second) => {
      const firstValue = getSortValue(first);
      const secondValue = getSortValue(second);
      return sortOrder === "Latest" ? secondValue - firstValue : firstValue - secondValue;
    });
  }, [items, query, statusFilter, sortOrder]);

  const statusCounts = useMemo(() => {
    return STATUS_OPTIONS.reduce((counts, status) => {
      counts[status] = items.filter((item) => item.status === status).length;
      return counts;
    }, {});
  }, [items]);

  const selectedRequisition = useMemo(() => {
    return items.find((item) => item.id === selectedRequisitionId) || null;
  }, [items, selectedRequisitionId]);

  const openForm = (item = null) => {
    if (item) {
      setEditingItem(item);
      setForm({
        item: item.item,
        category: item.category,
        quantity: item.quantity,
        neededDate: item.neededDate,
        priority: item.priority,
        requestedBy: item.requestedBy,
        chargeTo: item.chargeTo || "",
        notes: item.notes
      });
    } else {
      setEditingItem(null);
      setForm(EMPTY_FORM);
    }
    setIsFormOpen(true);
  };

  const saveItem = async () => {
    if (!form.item.trim() || !form.quantity.trim() || !form.requestedBy.trim() || !form.chargeTo.trim()) {
      Alert.alert("Missing information", "Item, quantity, requested by, and charge to are required.");
      return;
    }

    try {
      const response = await fetch(
        editingItem ? `${OTP_API_URL}/requisitions/${editingItem.id}` : `${OTP_API_URL}/requisitions`,
        {
          method: editingItem ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...form,
            projectId: selectedProjectId,
            changedBy: getEditorName(user)
          })
        }
      );
      const result = await response.json();

      if (!response.ok) {
        Alert.alert("Request not saved", result.error || "The backend could not save this requisition.");
        return;
      }

      if (editingItem) {
        setItems((current) =>
          current.map((item) => (item.id === editingItem.id ? result.requisition : item))
        );
      } else {
        setItems((current) => [result.requisition, ...current]);
      }
    } catch (error) {
      Alert.alert("Backend unavailable", `Start the backend, then try again.\n\n${OTP_API_URL}`);
      return;
    }

    setEditingItem(null);
    setForm(EMPTY_FORM);
    setIsFormOpen(false);
  };

  const deleteItem = async (id) => {
    try {
      const response = await fetch(`${OTP_API_URL}/requisitions/${id}`, {
        method: "DELETE"
      });
      const result = await response.json();

      if (!response.ok) {
        Alert.alert("Request not removed", result.error || "The backend could not remove this requisition.");
        return;
      }

      setItems((current) => current.filter((item) => item.id !== id));
    } catch (error) {
      Alert.alert("Backend unavailable", `Start the backend, then try again.\n\n${OTP_API_URL}`);
    }
  };

  const removeItem = (id) => {
    if (Platform.OS === "web") {
      deleteItem(id);
      return;
    }

    Alert.alert("Remove requisition", "This requisition will be removed from the list.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => deleteItem(id)
      }
    ]);
  };

  const changeStatus = async (id, status) => {
    const statusType = user?.role === "Procurement" ? "procurement" : "manager";

    try {
      const response = await fetch(`${OTP_API_URL}/requisitions/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          statusType,
          changedBy: getEditorName(user)
        })
      });
      const result = await response.json();

      if (!response.ok) {
        Alert.alert("Status not updated", result.error || "The backend could not update this status.");
        return;
      }

      setItems((current) =>
        current.map((item) => (item.id === id ? result.requisition : item))
      );
    } catch (error) {
      Alert.alert("Backend unavailable", `Start the backend, then try again.\n\n${OTP_API_URL}`);
    }
  };

  const changeDeliveryConfirmation = async (id, confirmation, remarks = "") => {
    if (confirmation === "With Discrepancy" && !remarks.trim()) {
      Alert.alert("Remarks required", "Add notes or remarks for the discrepancy before saving.");
      return;
    }

    try {
      const response = await fetch(`${OTP_API_URL}/requisitions/${id}/delivery`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmation,
          remarks,
          changedBy: getEditorName(user)
        })
      });
      const result = await response.json();

      if (!response.ok) {
        Alert.alert("Delivery confirmation not updated", result.error || "The backend could not update this delivery confirmation.");
        return;
      }

      setItems((current) =>
        current.map((item) => (item.id === id ? result.requisition : item))
      );
    } catch (error) {
      Alert.alert("Backend unavailable", `Start the backend, then try again.\n\n${OTP_API_URL}`);
    }
  };

  const loadAccounts = async () => {
    try {
      const response = await fetch(`${OTP_API_URL}/accounts`);
      const result = await response.json();

      if (response.ok && Array.isArray(result.accounts)) {
        setAccounts(result.accounts);
      }
    } catch (error) {
      console.log("Could not load backend accounts", error);
    }
  };

  const loadProjects = async () => {
    try {
      const response = await fetch(`${OTP_API_URL}/projects`);
      const result = await response.json();

      if (response.ok && Array.isArray(result.projects) && result.projects.length > 0) {
        setProjects(result.projects);

        if (!result.projects.some((project) => project.id === selectedProjectId)) {
          setSelectedProjectId(result.projects[0].id);
        }
      }
    } catch (error) {
      console.log("Could not load backend projects", error);
    }
  };

  const loadItems = async (projectId = selectedProjectId) => {
    try {
      const queryString = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      const response = await fetch(`${OTP_API_URL}/requisitions${queryString}`);
      const result = await response.json();

      if (response.ok && Array.isArray(result.requisitions)) {
        setItems(result.requisitions);
      }
    } catch (error) {
      console.log("Could not load backend requisitions", error);
    }
  };

  const updateProjectField = (field, value) => {
    setProjectForm((current) => ({ ...current, [field]: value }));
  };

  const saveProject = async () => {
    if (!projectForm.title.trim() || !projectForm.projectCode.trim()) {
      Alert.alert("Missing project information", "Project name/title and project code are required.");
      return;
    }

    try {
      const response = await fetch(`${OTP_API_URL}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectForm)
      });
      const result = await response.json();

      if (!response.ok) {
        Alert.alert("Project not saved", result.error || "The backend could not save this project.");
        return;
      }

      setProjects((current) => [...current, result.project]);
      setSelectedProjectId(result.project.id);
      setProjectForm(EMPTY_PROJECT_FORM);
      setIsProjectFormOpen(false);
      setIsProjectMenuOpen(false);
      setItems([]);
    } catch (error) {
      Alert.alert("Backend unavailable", `Start the backend, then try again.\n\n${OTP_API_URL}`);
    }
  };

  const login = async () => {
    if (isLoginLoading) {
      return;
    }

    const normalizedUsername = username.trim().toLowerCase();

    if (!normalizedUsername || !password.trim()) {
      Alert.alert("Login required", "Enter your username and password to continue.");
      return;
    }

    setIsLoginLoading(true);

    try {
      const response = await fetch(`${OTP_API_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: normalizedUsername,
          password,
          role: selectedRole
        })
      });
      const result = await response.json();

      if (!response.ok) {
        Alert.alert("Account not found", result.error || "Use a registered account with the correct role.");
        return;
      }

      setUser(result.account);
      loadItems();
    } catch (error) {
      Alert.alert("Backend unavailable", `Start the backend, then try again.\n\n${OTP_API_URL}`);
      return;
    } finally {
      setIsLoginLoading(false);
    }
  };

  const logout = () => {
    setUser(null);
    setSelectedRole("Staff");
    setUsername("");
    setPassword("");
    setQuery("");
    setStatusFilter("All");
  };

  const exportAllRequisitions = async () => {
    await exportPdfToDownloads({
      html: buildAllRequisitionsPdfHtml(items, selectedProject),
      fileName: buildPrsFileName(),
      successTitle: "Export complete",
      successMessage: `${selectedProject.title} requisitions were exported as a compact PDF table.`
    });
  };

  const shareAllRequisitions = async () => {
    await exportPdfForSharing({
      html: buildAllRequisitionsPdfHtml(items, selectedProject),
      fileName: buildPrsFileName(),
      successTitle: "Share ready",
      successMessage: `${selectedProject.title} requisitions were prepared as a compact PDF table.`
    });
  };

  const updateSignupField = (field, value) => {
    setSignupForm((current) => ({ ...current, [field]: value }));
  };

  const requestOneTimeCode = async () => {
    if (isOtpRequesting || otpCooldownSeconds > 0) {
      return;
    }

    const email = signupForm.email.trim().toLowerCase();
    const manager = managerAccounts.find((account) => account.username === signupForm.managerUsername);

    if (!email) {
      Alert.alert("Email required", "Enter your email before requesting a one-time code.");
      return;
    }

    if (!manager) {
      Alert.alert("Manager required", "Select the manager who should receive the one-time code.");
      return;
    }

    setIsOtpRequesting(true);

    try {
      const response = await fetch(`${OTP_API_URL}/otp/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          role: signupForm.role,
          managerUsername: manager.username,
          managerEmail: manager.email,
          managerName: getAccountName(manager)
        })
      });
      const result = await response.json();

      if (!response.ok) {
        Alert.alert("Code not sent", result.error || "The backend could not send the one-time code.");
        return;
      }

      Alert.alert(
        "Code requested",
        `A one-time sign-up code was sent to ${getAccountName(manager)} at ${manager.email}.`
      );
      setOtpCooldownSeconds(OTP_REQUEST_COOLDOWN_SECONDS);
    } catch (error) {
      Alert.alert("Backend unavailable", `Start the OTP backend, then try again.\n\n${OTP_API_URL}`);
    } finally {
      setIsOtpRequesting(false);
    }
  };

  const signup = async () => {
    const requiredFields = [
      "username",
      "password",
      "email",
      "firstName",
      "lastName",
      "department",
      "trade",
      "head",
      "managerUsername",
      "code"
    ];
    const missingField = requiredFields.find((field) => !signupForm[field].trim());
    const normalizedUsername = signupForm.username.trim().toLowerCase();
    const normalizedEmail = signupForm.email.trim().toLowerCase();

    if (missingField) {
      Alert.alert("Missing information", "Complete all required sign-up fields before creating the account.");
      return;
    }

    if (accounts.some((account) => account.username.toLowerCase() === normalizedUsername)) {
      Alert.alert("Username unavailable", "Choose a different username.");
      return;
    }

    try {
      const response = await fetch(`${OTP_API_URL}/otp/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: normalizedEmail,
          role: signupForm.role,
          managerUsername: signupForm.managerUsername,
          code: signupForm.code.trim()
        })
      });
      const result = await response.json();

      if (!response.ok || !result.valid) {
        Alert.alert("Invalid code", result.error || "Request a one-time code from the manager and enter the latest code.");
        return;
      }
    } catch (error) {
      Alert.alert("Backend unavailable", `Start the OTP backend, then try again.\n\n${OTP_API_URL}`);
      return;
    }

    const newAccount = {
      username: signupForm.username.trim(),
      password: signupForm.password,
      email: normalizedEmail,
      firstName: signupForm.firstName.trim(),
      middleName: signupForm.middleName.trim(),
      lastName: signupForm.lastName.trim(),
      department: signupForm.department.trim(),
      trade: signupForm.trade.trim(),
      head: signupForm.head.trim(),
      managerUsername: signupForm.managerUsername,
      role: signupForm.role
    };

    try {
      const response = await fetch(`${OTP_API_URL}/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newAccount)
      });
      const result = await response.json();

      if (!response.ok) {
        Alert.alert("Account not created", result.error || "The backend could not save the account.");
        return;
      }

      setAccounts((current) => [...current, result.account]);
    } catch (error) {
      Alert.alert("Backend unavailable", `Start the backend, then try again.\n\n${OTP_API_URL}`);
      return;
    }

    setSelectedRole(newAccount.role);
    setUsername(newAccount.username);
    setPassword("");
    setSignupForm(EMPTY_SIGNUP_FORM);
    setAuthMode("login");
    Alert.alert("Account created", "You can now log in with your new account.");
  };

  if (!user) {
    return (
      <AppFrame>
        <ScrollView contentContainerStyle={styles.authShell} showsVerticalScrollIndicator={false}>
          <Text style={styles.kicker}>Material and equipment requisition</Text>
          <Text style={styles.title}>{authMode === "login" ? "Sign in" : "Create account"}</Text>
          <Text style={styles.subtitle}>
            {authMode === "login"
              ? "Only registered accounts can access the requisition workspace."
              : "Select a registered manager, then request a one-time code before signing up."}
          </Text>

          <View style={styles.authTabs}>
            <HoverPressable
              style={[styles.authTab, authMode === "login" && styles.authTabActive]}
              onPress={() => setAuthMode("login")}
            >
              <Text style={[styles.authTabText, authMode === "login" && styles.authTabTextActive]}>Log in</Text>
            </HoverPressable>
            <HoverPressable
              style={[styles.authTab, authMode === "signup" && styles.authTabActive]}
              onPress={() => setAuthMode("signup")}
            >
              <Text style={[styles.authTabText, authMode === "signup" && styles.authTabTextActive]}>Sign up</Text>
            </HoverPressable>
          </View>

          {authMode === "login" ? (
            <View style={styles.loginPanel}>
              <Text style={styles.sectionLabel}>Role</Text>
              <View style={styles.roleGrid}>
                {ROLES.map((role) => (
                  <HoverPressable
                    key={role.key}
                    style={[styles.roleCard, selectedRole === role.key && styles.roleCardActive]}
                    onPress={() => setSelectedRole(role.key)}
                  >
                    <View style={styles.iconBadge}>
                      <Feather name={role.icon} size={22} color="#111827" />
                    </View>
                    <Text style={styles.roleName}>{role.key}</Text>
                    <Text style={styles.roleDescription}>{role.description}</Text>
                  </HoverPressable>
                ))}
              </View>
              <TextInput
                autoCapitalize="none"
                placeholder="Username"
                placeholderTextColor="#9ca3af"
                style={styles.input}
                value={username}
                onChangeText={setUsername}
              />
              <TextInput
                placeholder="Password"
                placeholderTextColor="#9ca3af"
                secureTextEntry
                style={styles.input}
                value={password}
                onChangeText={setPassword}
              />
              <HoverPressable
                style={[styles.primaryButton, isLoginLoading && styles.disabledButton]}
                onPress={login}
                disabled={isLoginLoading}
              >
                {isLoginLoading ? (
                  <>
                    <ActivityIndicator size="small" color="#ffffff" />
                    <Text style={styles.primaryButtonText}>Logging in...</Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.primaryButtonText}>Log in as {selectedRole}</Text>
                    <Feather name="arrow-right" size={18} color="#ffffff" />
                  </>
                )}
              </HoverPressable>
            </View>
          ) : (
            <View style={styles.loginPanel}>
              <Text style={styles.sectionLabel}>Requested role</Text>
              <View style={styles.segmented}>
                {ROLES.map((role) => (
                  <HoverPressable
                    key={role.key}
                    style={[styles.segment, signupForm.role === role.key && styles.segmentActive]}
                    onPress={() => updateSignupField("role", role.key)}
                  >
                    <Text style={[styles.segmentText, signupForm.role === role.key && styles.segmentTextActive]}>
                      {role.key}
                    </Text>
                  </HoverPressable>
                ))}
              </View>
              <TextInput
                autoCapitalize="none"
                placeholder="Preferred username"
                placeholderTextColor="#9ca3af"
                style={styles.input}
                value={signupForm.username}
                onChangeText={(value) => updateSignupField("username", value)}
              />
              <TextInput
                placeholder="Password"
                placeholderTextColor="#9ca3af"
                secureTextEntry
                style={styles.input}
                value={signupForm.password}
                onChangeText={(value) => updateSignupField("password", value)}
              />
              <TextInput
                autoCapitalize="none"
                keyboardType="email-address"
                placeholder="Email"
                placeholderTextColor="#9ca3af"
                style={styles.input}
                value={signupForm.email}
                onChangeText={(value) => updateSignupField("email", value)}
              />
              <View style={styles.twoColumn}>
                <TextInput
                  placeholder="First name"
                  placeholderTextColor="#9ca3af"
                  style={[styles.input, styles.flexInput]}
                  value={signupForm.firstName}
                  onChangeText={(value) => updateSignupField("firstName", value)}
                />
                <TextInput
                  placeholder="Middle name"
                  placeholderTextColor="#9ca3af"
                  style={[styles.input, styles.flexInput]}
                  value={signupForm.middleName}
                  onChangeText={(value) => updateSignupField("middleName", value)}
                />
              </View>
              <TextInput
                placeholder="Last name"
                placeholderTextColor="#9ca3af"
                style={styles.input}
                value={signupForm.lastName}
                onChangeText={(value) => updateSignupField("lastName", value)}
              />
              <TextInput
                placeholder="Department"
                placeholderTextColor="#9ca3af"
                style={styles.input}
                value={signupForm.department}
                onChangeText={(value) => updateSignupField("department", value)}
              />
              <TextInput
                placeholder="Trade"
                placeholderTextColor="#9ca3af"
                style={styles.input}
                value={signupForm.trade}
                onChangeText={(value) => updateSignupField("trade", value)}
              />
              <TextInput
                placeholder="Head"
                placeholderTextColor="#9ca3af"
                style={styles.input}
                value={signupForm.head}
                onChangeText={(value) => updateSignupField("head", value)}
              />
              <ManagerDropdown
                managers={managerAccounts}
                selectedUsername={signupForm.managerUsername}
                onSelect={(managerUsername) => updateSignupField("managerUsername", managerUsername)}
              />
              <View style={styles.codeRow}>
                <TextInput
                  keyboardType="number-pad"
                  placeholder="Requested one-time code"
                  placeholderTextColor="#9ca3af"
                  style={[styles.input, styles.codeInput]}
                  value={signupForm.code}
                  onChangeText={(value) => updateSignupField("code", value)}
                />
                <HoverPressable
                  style={styles.secondaryButton}
                  onPress={requestOneTimeCode}
                  disabled={isOtpRequesting || otpCooldownSeconds > 0}
                >
                  <Feather name={isOtpRequesting ? "loader" : "send"} size={17} color="#111827" />
                  <Text style={styles.secondaryButtonText}>
                    {isOtpRequesting
                      ? "Sending..."
                      : otpCooldownSeconds > 0
                        ? `Resend in ${otpCooldownSeconds}s`
                        : "Request"}
                  </Text>
                </HoverPressable>
              </View>
              <HoverPressable style={styles.primaryButton} onPress={signup}>
                <Text style={styles.primaryButtonText}>Create account</Text>
                <Feather name="user-plus" size={18} color="#ffffff" />
              </HoverPressable>
            </View>
          )}
        </ScrollView>
      </AppFrame>
    );
  }

  return (
    <AppFrame>
      <ScrollView contentContainerStyle={styles.dashboard} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.headerTextBlock}>
            <Text style={styles.kicker}>{user.role} workspace</Text>
            <Text style={styles.dashboardTitle}>Requisitions</Text>
            <Text style={styles.subtitle}>
              {selectedProject.title} project - Signed in as {user.firstName} {user.lastName}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {user.role === "Manager" && (
              <ProjectDropdown
                projects={projects}
                selectedProjectId={selectedProjectId}
                visible={isProjectMenuOpen}
                onOpen={() => setIsProjectMenuOpen(true)}
                onClose={() => setIsProjectMenuOpen(false)}
                onSelect={(projectId) => {
                  setSelectedProjectId(projectId);
                  setIsProjectMenuOpen(false);
                }}
                onCreate={() => {
                  setProjectForm(EMPTY_PROJECT_FORM);
                  setIsProjectMenuOpen(false);
                  setIsProjectFormOpen(true);
                }}
              />
            )}
            <HoverPressable style={styles.headerIconButton} onPress={exportAllRequisitions}>
              <Feather name="download" size={18} color="#111827" />
            </HoverPressable>
            <HoverPressable style={styles.headerIconButton} onPress={shareAllRequisitions}>
              <Feather name="share-2" size={18} color="#111827" />
            </HoverPressable>
            <HoverPressable style={styles.headerIconButton} onPress={logout}>
              <Feather name="log-out" size={18} color="#111827" />
            </HoverPressable>
          </View>
        </View>

        <View style={styles.statsRow}>
          <Stat label="Total" value={items.length} />
          <Stat label="Approved" value={statusCounts.Approved || 0} />
          <Stat label="Ordered" value={statusCounts.Ordered || 0} />
        </View>

        <View style={styles.toolbar}>
          <View style={styles.searchBox}>
            <Feather name="search" size={18} color="#6b7280" />
            <TextInput
              placeholder="Search requisitions"
              placeholderTextColor="#9ca3af"
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
            />
          </View>
          <View style={styles.toolbarActions}>
            {permissions.add && (
              <HoverPressable style={styles.addButton} onPress={() => openForm()}>
                <Feather name="plus" size={18} color="#ffffff" />
                <Text style={styles.addButtonText}>Add</Text>
              </HoverPressable>
            )}
            <SortViewDropdown
              visible={isDisplayMenuOpen}
              sortOrder={sortOrder}
              viewMode={viewMode}
              onOpen={() => setIsDisplayMenuOpen(true)}
              onClose={() => setIsDisplayMenuOpen(false)}
              onSortChange={setSortOrder}
              onViewChange={setViewMode}
            />
          </View>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.statusTabs}>
          {["All", ...STATUS_OPTIONS].map((status) => (
            <HoverPressable
              key={status}
              style={[styles.statusTab, statusFilter === status && styles.statusTabActive]}
              onPress={() => setStatusFilter(status)}
            >
              <Text style={[styles.statusTabText, statusFilter === status && styles.statusTabTextActive]}>{status}</Text>
            </HoverPressable>
          ))}
        </ScrollView>

        <View style={styles.permissionBar}>
          {Object.entries(permissions).map(([key, allowed]) => (
            <View key={key} style={[styles.permissionChip, allowed && styles.permissionChipAllowed]}>
              <Feather name={allowed ? "check" : "minus"} size={14} color={allowed ? "#047857" : "#9ca3af"} />
              <Text style={[styles.permissionText, allowed && styles.permissionTextAllowed]}>{key}</Text>
            </View>
          ))}
        </View>

        <View style={styles.list}>
          {filteredItems.map((item) => (
            <RequisitionCard
              key={item.id}
              item={item}
              permissions={permissions}
              onEdit={() => openForm(item)}
              onRemove={() => removeItem(item.id)}
              onStatusChange={(status) => changeStatus(item.id, status)}
              statusOptions={statusOptionsForUser}
              canConfirmDelivery={canConfirmDelivery}
              onDeliveryConfirm={(confirmation, remarks) => changeDeliveryConfirmation(item.id, confirmation, remarks)}
              viewMode={viewMode}
              onSelect={() => setSelectedRequisitionId(item.id)}
            />
          ))}
          {filteredItems.length === 0 && (
            <View style={styles.emptyState}>
              <Feather name="inbox" size={28} color="#9ca3af" />
              <Text style={styles.emptyTitle}>No requisitions found</Text>
              <Text style={styles.emptyText}>Try a different search or status filter.</Text>
            </View>
          )}
        </View>
      </ScrollView>

      <ItemModal
        visible={isFormOpen}
        editingItem={editingItem}
        form={form}
        setForm={setForm}
        onClose={() => {
          setEditingItem(null);
          setForm(EMPTY_FORM);
          setIsFormOpen(false);
        }}
        onSave={saveItem}
      />

      <ProjectFormModal
        visible={isProjectFormOpen}
        form={projectForm}
        onChange={updateProjectField}
        onClose={() => {
          setProjectForm(EMPTY_PROJECT_FORM);
          setIsProjectFormOpen(false);
        }}
        onSave={saveProject}
      />

      <RequisitionDetailModal
        visible={!!selectedRequisition}
        item={selectedRequisition}
        project={selectedProject}
        onClose={() => setSelectedRequisitionId(null)}
      />
    </AppFrame>
  );
}

function AppFrame({ children }) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <ExpoStatusBar style="dark" />
      <View style={styles.container}>{children}</View>
    </SafeAreaView>
  );
}

function HoverPressable({ children, style, onPress, disabled = false }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ hovered, pressed }) => [
        style,
        hovered && !disabled && styles.hovered,
        pressed && !disabled && styles.pressed,
        disabled && styles.disabledControl
      ]}
    >
      {children}
    </Pressable>
  );
}

function Stat({ label, value }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function RequisitionCard({
  item,
  permissions,
  onEdit,
  onRemove,
  onStatusChange,
  statusOptions,
  canConfirmDelivery,
  onDeliveryConfirm,
  viewMode,
  onSelect
}) {
  const editHistory = Array.isArray(item.editHistory) ? item.editHistory : [];
  const latestEdit = editHistory[0];
  const isFull = viewMode === "Full";
  const isSmall = viewMode === "Small";
  const showDetails = isFull || isSmall;
  const showName = viewMode !== "Numbers";
  const hasDeliveryConfirmation = Boolean(item.deliveryConfirmation);
  const showDeliveryConfirmation = canConfirmDelivery && item.procurementStatus === "Delivered" && !hasDeliveryConfirmation;

  return (
    <HoverPressable style={[styles.itemCard, viewMode !== "Full" && styles.itemCardCompact]} onPress={onSelect}>
      <View style={styles.itemTop}>
        <View style={styles.itemTitleBlock}>
          <Text style={styles.itemId}>{item.id}</Text>
          {showName && <Text style={[styles.itemName, viewMode !== "Full" && styles.itemNameCompact]}>{item.item}</Text>}
        </View>
        <View style={styles.cardStatusStack}>
          <View style={[styles.statusPill, getStatusStyle(item.status)]}>
            <Text style={styles.statusPillText}>Manager: {item.status}</Text>
          </View>
          {!!item.procurementStatus && (
            <View style={[styles.statusPill, styles.procurementPill]}>
              <Text style={styles.statusPillText}>Proc: {item.procurementStatus}</Text>
            </View>
          )}
          {hasDeliveryConfirmation && (
            <View style={[styles.statusPill, styles.deliveryPill]}>
              <Text style={styles.statusPillText}>Delivery: {item.deliveryConfirmation}</Text>
            </View>
          )}
        </View>
      </View>

      <View style={[styles.detailsGrid, !showDetails && styles.detailsGridTight]}>
        <Detail label="Quantity" value={item.quantity} />
        {showDetails && (
          <>
            <Detail label="Category" value={item.category || "Unspecified"} />
            <Detail label="Needed" value={item.neededDate || "Not set"} />
            <Detail label="Priority" value={item.priority} />
            <Detail label="Charge to" value={item.chargeTo || "Unspecified"} />
            {hasDeliveryConfirmation && <Detail label="Delivery" value={item.deliveryConfirmation} />}
          </>
        )}
      </View>

      {showDetails && (
        <>
          {isFull && <Text style={styles.notes}>{item.notes || "No additional notes."}</Text>}
          <Text style={styles.requestedBy}>Requested by {item.requestedBy}</Text>
        </>
      )}

      {isFull && <View style={styles.historyBlock}>
        <Text style={styles.historyTitle}>Latest edit</Text>
        {!latestEdit ? (
          <Text style={styles.historyEmpty}>No edits recorded yet.</Text>
        ) : (
          <HistoryRow history={latestEdit} />
        )}
      </View>}

      <View style={styles.cardActions}>
        <HoverPressable style={styles.secondaryButton} onPress={onSelect}>
          <Feather name="eye" size={16} color="#111827" />
          <Text style={styles.secondaryButtonText}>View</Text>
        </HoverPressable>
        {permissions.status && (
          <StatusDropdown status={item.status} options={statusOptions} onSelect={onStatusChange} />
        )}
        {showDeliveryConfirmation && (
          <DeliveryConfirmationDropdown item={item} onSelect={onDeliveryConfirm} />
        )}
        {permissions.edit && (
          <HoverPressable style={styles.secondaryButton} onPress={onEdit}>
            <Feather name="edit-3" size={16} color="#111827" />
            <Text style={styles.secondaryButtonText}>Edit</Text>
          </HoverPressable>
        )}
        {permissions.remove && (
          <HoverPressable style={styles.dangerButton} onPress={onRemove}>
            <Feather name="trash-2" size={16} color="#b91c1c" />
          </HoverPressable>
        )}
      </View>
    </HoverPressable>
  );
}

function Detail({ label, value }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function DetailRow({ label, value }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailRowLabel}>{label}</Text>
      <Text style={styles.detailRowValue}>{value}</Text>
    </View>
  );
}

function StatusDropdown({ status, options, onSelect }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <View>
      <HoverPressable style={styles.secondaryButton} onPress={() => setIsOpen(true)}>
        <Feather name="list" size={16} color="#111827" />
        <Text style={styles.secondaryButtonText}>Status</Text>
        <Feather name="chevron-down" size={16} color="#111827" />
      </HoverPressable>

      <Modal visible={isOpen} animationType="fade" transparent onRequestClose={() => setIsOpen(false)}>
        <View style={styles.dropdownOverlay}>
          <View style={styles.dropdownPanel}>
            <View style={styles.dropdownHeader}>
              <Text style={styles.modalTitle}>Update status</Text>
              <HoverPressable style={styles.iconButton} onPress={() => setIsOpen(false)}>
                <Feather name="x" size={20} color="#111827" />
              </HoverPressable>
            </View>

            <View style={styles.managerList}>
              {options.map((option) => {
                const isSelected = option === status;
                return (
                  <HoverPressable
                    key={option}
                    style={[styles.managerOption, isSelected && styles.managerOptionActive]}
                    onPress={() => {
                      onSelect(option);
                      setIsOpen(false);
                    }}
                  >
                    <Text style={styles.managerName}>{option}</Text>
                    {isSelected && <Feather name="check" size={18} color="#047857" />}
                  </HoverPressable>
                );
              })}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function DeliveryConfirmationDropdown({ item, onSelect }) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedOption, setSelectedOption] = useState(item.deliveryConfirmation || "Confirmed");
  const [remarks, setRemarks] = useState(item.deliveryRemarks || "");

  const close = () => {
    setSelectedOption(item.deliveryConfirmation || "Confirmed");
    setRemarks(item.deliveryRemarks || "");
    setIsOpen(false);
  };

  const save = () => {
    if (selectedOption === "With Discrepancy" && !remarks.trim()) {
      Alert.alert("Remarks required", "Add notes or remarks for the discrepancy before saving.");
      return;
    }

    onSelect(selectedOption, selectedOption === "With Discrepancy" ? remarks : "");
    setIsOpen(false);
  };

  return (
    <View>
      <HoverPressable style={styles.secondaryButton} onPress={() => setIsOpen(true)}>
        <Feather name="check-square" size={16} color="#111827" />
        <Text style={styles.secondaryButtonText}>{item.deliveryConfirmation || "Delivery"}</Text>
        <Feather name="chevron-down" size={16} color="#111827" />
      </HoverPressable>

      <Modal visible={isOpen} animationType="fade" transparent onRequestClose={close}>
        <View style={styles.dropdownOverlay}>
          <View style={styles.dropdownPanel}>
            <View style={styles.dropdownHeader}>
              <View>
                <Text style={styles.kicker}>Delivered item</Text>
                <Text style={styles.modalTitle}>Confirm delivery</Text>
              </View>
              <HoverPressable style={styles.iconButton} onPress={close}>
                <Feather name="x" size={20} color="#111827" />
              </HoverPressable>
            </View>

            <View style={styles.managerList}>
              {DELIVERY_CONFIRMATION_OPTIONS.map((option) => {
                const isSelected = option === selectedOption;
                return (
                  <HoverPressable
                    key={option}
                    style={[styles.managerOption, isSelected && styles.managerOptionActive]}
                    onPress={() => setSelectedOption(option)}
                  >
                    <Text style={styles.managerName}>{option}</Text>
                    {isSelected && <Feather name="check" size={18} color="#047857" />}
                  </HoverPressable>
                );
              })}
            </View>

            {selectedOption === "With Discrepancy" && (
              <TextInput
                multiline
                placeholder="Add discrepancy remarks"
                placeholderTextColor="#9ca3af"
                style={[styles.input, styles.textarea]}
                value={remarks}
                onChangeText={setRemarks}
              />
            )}

            <HoverPressable style={styles.primaryButton} onPress={save}>
              <Text style={styles.primaryButtonText}>Save confirmation</Text>
              <Feather name="check" size={18} color="#ffffff" />
            </HoverPressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function SortViewDropdown({ visible, sortOrder, viewMode, onOpen, onClose, onSortChange, onViewChange }) {
  const selectSort = (option) => {
    onSortChange(option);
  };

  const selectView = (option) => {
    onViewChange(option);
  };

  return (
    <View>
      <HoverPressable style={styles.displayMenuButton} onPress={onOpen}>
        <Feather name="sliders" size={17} color="#111827" />
        <Text style={styles.displayMenuButtonText}>{sortOrder} - {viewMode}</Text>
        <Feather name="chevron-down" size={16} color="#111827" />
      </HoverPressable>

      <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
        <View style={styles.dropdownOverlay}>
          <View style={styles.dropdownPanel}>
            <View style={styles.dropdownHeader}>
              <View>
                <Text style={styles.kicker}>Dashboard display</Text>
                <Text style={styles.modalTitle}>Sort and view</Text>
              </View>
              <HoverPressable style={styles.iconButton} onPress={onClose}>
                <Feather name="x" size={20} color="#111827" />
              </HoverPressable>
            </View>

            <View style={styles.displayMenuSection}>
              <Text style={styles.controlLabel}>Sort</Text>
              <View style={styles.controlSegments}>
                {["Latest", "Oldest"].map((option) => (
                  <HoverPressable
                    key={option}
                    style={[styles.controlSegment, sortOrder === option && styles.controlSegmentActive]}
                    onPress={() => selectSort(option)}
                  >
                    <Text style={[styles.controlSegmentText, sortOrder === option && styles.controlSegmentTextActive]}>
                      {option}
                    </Text>
                  </HoverPressable>
                ))}
              </View>
            </View>

            <View style={styles.displayMenuSection}>
              <Text style={styles.controlLabel}>View</Text>
              <View style={styles.controlSegments}>
                {["Full", "Small", "Names", "Numbers"].map((option) => (
                  <HoverPressable
                    key={option}
                    style={[styles.controlSegment, viewMode === option && styles.controlSegmentActive]}
                    onPress={() => selectView(option)}
                  >
                    <Text style={[styles.controlSegmentText, viewMode === option && styles.controlSegmentTextActive]}>
                      {option}
                    </Text>
                  </HoverPressable>
                ))}
              </View>
            </View>

            <HoverPressable style={styles.primaryButton} onPress={onClose}>
              <Text style={styles.primaryButtonText}>Apply</Text>
              <Feather name="check" size={18} color="#ffffff" />
            </HoverPressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function ProjectDropdown({ projects, selectedProjectId, visible, onOpen, onClose, onSelect, onCreate }) {
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  return (
    <View>
      <HoverPressable style={styles.projectMenuButton} onPress={onOpen}>
        <Feather name="folder" size={17} color="#111827" />
        <Text style={styles.projectMenuButtonText}>Projects</Text>
        <Feather name="chevron-down" size={16} color="#111827" />
      </HoverPressable>

      <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
        <View style={styles.dropdownOverlay}>
          <View style={styles.dropdownPanel}>
            <View style={styles.dropdownHeader}>
              <View>
                <Text style={styles.kicker}>Current project</Text>
                <Text style={styles.modalTitle}>{selectedProject?.title || "Projects"}</Text>
              </View>
              <HoverPressable style={styles.iconButton} onPress={onClose}>
                <Feather name="x" size={20} color="#111827" />
              </HoverPressable>
            </View>

            <ScrollView style={styles.projectMenuList} showsVerticalScrollIndicator={false}>
              <View style={styles.managerList}>
                {projects.map((project) => {
                  const isSelected = project.id === selectedProjectId;
                  const meta = [project.projectCode, project.locationSite].filter(Boolean).join(" - ");

                  return (
                    <HoverPressable
                      key={project.id}
                      style={[styles.managerOption, isSelected && styles.managerOptionActive]}
                      onPress={() => onSelect(project.id)}
                    >
                      <View style={styles.managerOptionText}>
                        <Text style={styles.managerName}>{project.title}</Text>
                        <Text style={styles.managerEmail}>{meta || "No project details yet"}</Text>
                      </View>
                      {isSelected && <Feather name="check" size={18} color="#047857" />}
                    </HoverPressable>
                  );
                })}
              </View>
            </ScrollView>

            <HoverPressable style={styles.primaryButton} onPress={onCreate}>
              <Text style={styles.primaryButtonText}>Add new project</Text>
              <Feather name="plus" size={18} color="#ffffff" />
            </HoverPressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function ManagerDropdown({ managers, selectedUsername, onSelect }) {
  const [isOpen, setIsOpen] = useState(false);
  const selectedManager = managers.find((manager) => manager.username === selectedUsername);

  return (
    <View>
      <Text style={styles.sectionLabel}>Manager to receive code</Text>
      <HoverPressable style={styles.dropdownButton} onPress={() => setIsOpen(true)}>
        <View style={styles.dropdownTextBlock}>
          <Text style={[styles.dropdownValue, !selectedManager && styles.dropdownPlaceholder]}>
            {selectedManager ? getAccountName(selectedManager) : "Select registered manager"}
          </Text>
          {selectedManager && <Text style={styles.dropdownSubtext}>{selectedManager.email}</Text>}
        </View>
        <Feather name="chevron-down" size={20} color="#475569" />
      </HoverPressable>

      <Modal visible={isOpen} animationType="fade" transparent onRequestClose={() => setIsOpen(false)}>
        <View style={styles.dropdownOverlay}>
          <View style={styles.dropdownPanel}>
            <View style={styles.dropdownHeader}>
              <Text style={styles.modalTitle}>Select manager</Text>
              <HoverPressable style={styles.iconButton} onPress={() => setIsOpen(false)}>
                <Feather name="x" size={20} color="#111827" />
              </HoverPressable>
            </View>

            {managers.length === 0 ? (
              <View style={styles.emptyState}>
                <Feather name="briefcase" size={26} color="#9ca3af" />
                <Text style={styles.emptyTitle}>No managers found</Text>
                <Text style={styles.emptyText}>Register a manager account before requesting a code.</Text>
              </View>
            ) : (
              <View style={styles.managerList}>
                {managers.map((manager) => {
                  const isSelected = manager.username === selectedUsername;
                  return (
                    <HoverPressable
                      key={manager.username}
                      style={[styles.managerOption, isSelected && styles.managerOptionActive]}
                      onPress={() => {
                        onSelect(manager.username);
                        setIsOpen(false);
                      }}
                    >
                      <View style={styles.managerOptionText}>
                        <Text style={styles.managerName}>{getAccountName(manager)}</Text>
                        <Text style={styles.managerEmail}>{manager.email}</Text>
                      </View>
                      {isSelected && <Feather name="check" size={18} color="#047857" />}
                    </HoverPressable>
                  );
                })}
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function CalendarField({ value, onSelect, label = "Needed date", placeholder = "Select needed date" }) {
  const [isOpen, setIsOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => parseDate(value) || new Date());
  const monthStart = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
  const calendarDays = getCalendarDays(monthStart);

  const moveMonth = (amount) => {
    setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));
  };

  return (
    <View>
      <Text style={styles.sectionLabel}>{label}</Text>
      <HoverPressable style={styles.dropdownButton} onPress={() => setIsOpen(true)}>
        <View style={styles.dropdownTextBlock}>
          <Text style={[styles.dropdownValue, !value && styles.dropdownPlaceholder]}>
            {value || placeholder}
          </Text>
        </View>
        <Feather name="calendar" size={20} color="#475569" />
      </HoverPressable>

      <Modal visible={isOpen} animationType="fade" transparent onRequestClose={() => setIsOpen(false)}>
        <View style={styles.dropdownOverlay}>
          <View style={styles.dropdownPanel}>
            <View style={styles.calendarHeader}>
              <HoverPressable style={styles.iconButton} onPress={() => moveMonth(-1)}>
                <Feather name="chevron-left" size={20} color="#111827" />
              </HoverPressable>
              <Text style={styles.calendarTitle}>
                {monthStart.toLocaleString("en-US", { month: "long", year: "numeric" })}
              </Text>
              <HoverPressable style={styles.iconButton} onPress={() => moveMonth(1)}>
                <Feather name="chevron-right" size={20} color="#111827" />
              </HoverPressable>
            </View>

            <View style={styles.weekdayRow}>
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                <Text key={day} style={styles.weekdayText}>{day}</Text>
              ))}
            </View>

            <View style={styles.calendarGrid}>
              {calendarDays.map((day) => {
                const formatted = formatDate(day.date);
                const isSelected = formatted === value;
                const isCurrentMonth = day.date.getMonth() === monthStart.getMonth();

                return (
                  <HoverPressable
                    key={formatted}
                    style={[
                      styles.calendarDay,
                      !isCurrentMonth && styles.calendarDayMuted,
                      isSelected && styles.calendarDayActive
                    ]}
                    onPress={() => {
                      onSelect(formatted);
                      setIsOpen(false);
                    }}
                  >
                    <Text style={[styles.calendarDayText, isSelected && styles.calendarDayTextActive]}>
                      {day.date.getDate()}
                    </Text>
                  </HoverPressable>
                );
              })}
            </View>

            <HoverPressable style={styles.secondaryButton} onPress={() => setIsOpen(false)}>
              <Feather name="x" size={16} color="#111827" />
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </HoverPressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function HistoryRow({ history }) {
  return (
    <View style={styles.historyRow}>
      <View style={styles.historyDot} />
      <View style={styles.historyTextBlock}>
        <Text style={styles.historyAction}>
          {history.action} by {history.changedBy}
        </Text>
        <Text style={styles.historyDetails}>{history.details}</Text>
        <Text style={styles.historyDate}>{formatHistoryDate(history.createdAt)}</Text>
      </View>
    </View>
  );
}

function RequisitionDetailModal({ visible, item, project, onClose }) {
  if (!item) {
    return null;
  }

  const editHistory = Array.isArray(item.editHistory) ? item.editHistory : [];

  const exportPdf = async () => {
    await exportPdfToDownloads({
      html: buildRequisitionPdfHtml(item, project),
      fileName: buildPrsFileName(item),
      successTitle: "Export complete",
      successMessage: `${item.id} was saved as a PDF.`
    });
  };

  const sharePdf = async () => {
    await exportPdfForSharing({
      html: buildRequisitionPdfHtml(item, project),
      fileName: buildPrsFileName(item),
      successTitle: "Share ready",
      successMessage: `${item.id} was prepared as a PDF.`
    });
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalPanel}>
          <View style={styles.modalHeader}>
            <View style={styles.modalTitleBlock}>
              <Text style={styles.kicker}>Full requisition details</Text>
              <Text style={styles.modalTitle}>{item.id}</Text>
            </View>
            <HoverPressable style={styles.iconButton} onPress={onClose}>
              <Feather name="x" size={20} color="#111827" />
            </HoverPressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={styles.detailHero}>
              <Text style={styles.detailHeroTitle}>{item.item}</Text>
              <View style={styles.detailStatusRow}>
                <View style={[styles.statusPill, getStatusStyle(item.status)]}>
                  <Text style={styles.statusPillText}>Manager: {item.status || "Not set"}</Text>
                </View>
                <View style={[styles.statusPill, styles.procurementPill]}>
                  <Text style={styles.statusPillText}>Proc: {item.procurementStatus || "Not set"}</Text>
                </View>
                {!!item.deliveryConfirmation && (
                  <View style={[styles.statusPill, styles.deliveryPill]}>
                    <Text style={styles.statusPillText}>Delivery: {item.deliveryConfirmation}</Text>
                  </View>
                )}
              </View>
            </View>

            <View style={styles.detailSection}>
              <Text style={styles.detailSectionTitle}>Request information</Text>
              <DetailRow label="Project" value={project?.title || "Sample"} />
              <DetailRow label="Project code" value={project?.projectCode || "SAMPLE"} />
              <DetailRow label="Item / Equipment" value={item.item || "Unspecified"} />
              <DetailRow label="Category" value={item.category || "Unspecified"} />
              <DetailRow label="Quantity" value={item.quantity || "Unspecified"} />
              <DetailRow label="Needed date" value={item.neededDate || "Not set"} />
              <DetailRow label="Priority" value={item.priority || "Normal"} />
              <DetailRow label="Requested by" value={item.requestedBy || "Unspecified"} />
              <DetailRow label="Charge to" value={item.chargeTo || "Unspecified"} />
              <DetailRow label="Manager status" value={item.status || "Not set"} />
              <DetailRow label="Procurement status" value={item.procurementStatus || "Not set"} />
              <DetailRow label="Delivery confirmation" value={item.deliveryConfirmation || "Not set"} />
              <DetailRow label="Delivery remarks" value={item.deliveryRemarks || "None"} />
            </View>

            <View style={styles.detailSection}>
              <Text style={styles.detailSectionTitle}>Notes</Text>
              <Text style={styles.detailNotes}>{item.notes || "No additional notes."}</Text>
            </View>

            <View style={styles.detailSection}>
              <Text style={styles.detailSectionTitle}>Edit history</Text>
              {editHistory.length === 0 ? (
                <Text style={styles.historyEmpty}>No edits recorded yet.</Text>
              ) : (
                <View style={styles.detailHistoryList}>
                  {editHistory.map((history, index) => (
                    <HistoryRow key={history.id || `${history.createdAt}-${index}`} history={history} />
                  ))}
                </View>
              )}
            </View>
          </ScrollView>

          <View style={styles.detailActions}>
            <HoverPressable style={styles.secondaryButton} onPress={onClose}>
              <Feather name="arrow-left" size={16} color="#111827" />
              <Text style={styles.secondaryButtonText}>Back</Text>
            </HoverPressable>
            <HoverPressable style={styles.primaryButton} onPress={exportPdf}>
              <Text style={styles.primaryButtonText}>Export PDF</Text>
              <Feather name="download" size={18} color="#ffffff" />
            </HoverPressable>
            <HoverPressable style={styles.secondaryButton} onPress={sharePdf}>
              <Feather name="share-2" size={16} color="#111827" />
              <Text style={styles.secondaryButtonText}>Share</Text>
            </HoverPressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ProjectFormModal({ visible, form, onChange, onClose, onSave }) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalPanel}>
          <View style={styles.modalHeader}>
            <View style={styles.modalTitleBlock}>
              <Text style={styles.kicker}>Project setup</Text>
              <Text style={styles.modalTitle}>Add new project</Text>
            </View>
            <HoverPressable style={styles.iconButton} onPress={onClose}>
              <Feather name="x" size={20} color="#111827" />
            </HoverPressable>
          </View>

          <ScrollView contentContainerStyle={styles.formStack} showsVerticalScrollIndicator={false}>
            <TextInput
              placeholder="Project name/title"
              placeholderTextColor="#9ca3af"
              style={styles.input}
              value={form.title}
              onChangeText={(value) => onChange("title", value)}
            />
            <TextInput
              placeholder="Project code"
              placeholderTextColor="#9ca3af"
              autoCapitalize="characters"
              style={styles.input}
              value={form.projectCode}
              onChangeText={(value) => onChange("projectCode", value)}
            />
            <TextInput
              placeholder="Director"
              placeholderTextColor="#9ca3af"
              style={styles.input}
              value={form.director}
              onChangeText={(value) => onChange("director", value)}
            />
            <View style={styles.twoColumn}>
              <View style={styles.flexInput}>
                <CalendarField
                  label="Start date"
                  placeholder="Select start date"
                  value={form.startDate}
                  onSelect={(value) => onChange("startDate", value)}
                />
              </View>
              <View style={styles.flexInput}>
                <CalendarField
                  label="End date"
                  placeholder="Select end date"
                  value={form.endDate}
                  onSelect={(value) => onChange("endDate", value)}
                />
              </View>
            </View>
            <TextInput
              multiline
              placeholder="Manager/s"
              placeholderTextColor="#9ca3af"
              style={[styles.input, styles.textarea]}
              value={form.managers}
              onChangeText={(value) => onChange("managers", value)}
            />
            <TextInput
              multiline
              placeholder="Engineer/s"
              placeholderTextColor="#9ca3af"
              style={[styles.input, styles.textarea]}
              value={form.engineers}
              onChangeText={(value) => onChange("engineers", value)}
            />
            <TextInput
              placeholder="Project costs"
              placeholderTextColor="#9ca3af"
              style={styles.input}
              value={form.projectCosts}
              onChangeText={(value) => onChange("projectCosts", value)}
            />
            <TextInput
              multiline
              placeholder="Contractor/s"
              placeholderTextColor="#9ca3af"
              style={[styles.input, styles.textarea]}
              value={form.contractors}
              onChangeText={(value) => onChange("contractors", value)}
            />
            <TextInput
              placeholder="Location/Site"
              placeholderTextColor="#9ca3af"
              style={styles.input}
              value={form.locationSite}
              onChangeText={(value) => onChange("locationSite", value)}
            />
          </ScrollView>

          <HoverPressable style={styles.primaryButton} onPress={onSave}>
            <Text style={styles.primaryButtonText}>Save project</Text>
            <Feather name="check" size={18} color="#ffffff" />
          </HoverPressable>
        </View>
      </View>
    </Modal>
  );
}

function ItemModal({ visible, editingItem, form, setForm, onClose, onSave }) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalPanel}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.kicker}>{editingItem ? "Edit request" : "New request"}</Text>
              <Text style={styles.modalTitle}>{editingItem ? editingItem.id : "Create requisition"}</Text>
            </View>
            <HoverPressable style={styles.iconButton} onPress={onClose}>
              <Feather name="x" size={20} color="#111827" />
            </HoverPressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            <TextInput
              placeholder="Item or equipment"
              placeholderTextColor="#9ca3af"
              style={styles.input}
              value={form.item}
              onChangeText={(item) => setForm((current) => ({ ...current, item }))}
            />
            <TextInput
              placeholder="Category"
              placeholderTextColor="#9ca3af"
              style={styles.input}
              value={form.category}
              onChangeText={(category) => setForm((current) => ({ ...current, category }))}
            />
            <TextInput
              keyboardType="number-pad"
              placeholder="Quantity"
              placeholderTextColor="#9ca3af"
              style={styles.input}
              value={form.quantity}
              onChangeText={(quantity) => setForm((current) => ({ ...current, quantity }))}
            />
            <CalendarField
              value={form.neededDate}
              onSelect={(neededDate) => setForm((current) => ({ ...current, neededDate }))}
            />
            <TextInput
              placeholder="Requested by"
              placeholderTextColor="#9ca3af"
              style={styles.input}
              value={form.requestedBy}
              onChangeText={(requestedBy) => setForm((current) => ({ ...current, requestedBy }))}
            />
            <TextInput
              placeholder="Charge to"
              placeholderTextColor="#9ca3af"
              style={styles.input}
              value={form.chargeTo}
              onChangeText={(chargeTo) => setForm((current) => ({ ...current, chargeTo }))}
            />
            <View style={styles.segmented}>
              {PRIORITY_OPTIONS.map((priority) => (
                <HoverPressable
                  key={priority}
                  style={[styles.segment, form.priority === priority && styles.segmentActive]}
                  onPress={() => setForm((current) => ({ ...current, priority }))}
                >
                  <Text style={[styles.segmentText, form.priority === priority && styles.segmentTextActive]}>
                    {priority}
                  </Text>
                </HoverPressable>
              ))}
            </View>
            <TextInput
              multiline
              placeholder="Notes"
              placeholderTextColor="#9ca3af"
              style={[styles.input, styles.textarea]}
              value={form.notes}
              onChangeText={(notes) => setForm((current) => ({ ...current, notes }))}
            />
          </ScrollView>

          <HoverPressable style={styles.primaryButton} onPress={onSave}>
            <Text style={styles.primaryButtonText}>{editingItem ? "Save changes" : "Add request"}</Text>
            <Feather name="check" size={18} color="#ffffff" />
          </HoverPressable>
        </View>
      </View>
    </Modal>
  );
}

function getStatusStyle(status) {
  switch (status) {
    case "Approved":
    case "Received":
      return styles.statusGreen;
    case "Rejected":
      return styles.statusRed;
    case "Ordered":
    case "Purchased":
    case "Delivered":
      return styles.statusBlue;
    case "Review":
    case "On-Bidding":
    case "For Quotation":
    case "Under Cost Control":
      return styles.statusAmber;
    default:
      return styles.statusNeutral;
  }
}

function getAccountName(account) {
  return [account.firstName, account.lastName].filter(Boolean).join(" ") || account.username;
}

function getEditorName(account) {
  if (!account) {
    return "Unknown user";
  }

  return getAccountName(account);
}

function parseDate(value) {
  if (!value) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);

  if (!year || !month || !day) {
    return null;
  }

  return new Date(year, month - 1, day);
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCalendarDays(monthStart) {
  const firstDay = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1);
  const start = new Date(firstDay);
  start.setDate(firstDay.getDate() - firstDay.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return { date };
  });
}

function formatHistoryDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getDisplayValue(value, fallback = "Not set") {
  return value ? String(value) : fallback;
}

function buildPdfRow(label, value) {
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

async function exportPdfForSharing({ html, fileName, successTitle, successMessage }) {
  try {
    const { uri } = await Print.printToFileAsync({ html, base64: false });

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, {
        mimeType: "application/pdf",
        dialogTitle: fileName,
        UTI: "com.adobe.pdf"
      });
      return;
    }

    Alert.alert(successTitle, `${successMessage}\n\nPDF created at:\n${uri}`);
  } catch (error) {
    Alert.alert("Share failed", "The requisition PDF could not be shared. Please try again.");
  }
}

async function exportPdfToDownloads({ html, fileName, successTitle, successMessage }) {
  try {
    const { uri } = await Print.printToFileAsync({ html, base64: false });

    if (Platform.OS === "android") {
      const permissions = await requestAndroidExportDirectoryAccess();

      if (!permissions.granted) {
        Alert.alert("Export cancelled", "Allow access to a folder to save the PDF there.");
        return;
      }

      await writePdfToSafDirectory(uri, permissions.directoryUri, fileName);
      Alert.alert(successTitle, `${successMessage}\n\nSaved to your selected folder.`);
      return;
    }

    const documentsUri = `${FileSystem.documentDirectory}${fileName}`;
    await FileSystem.copyAsync({ from: uri, to: documentsUri });
    Alert.alert(successTitle, `${successMessage}\n\nSaved to app documents as ${fileName}.`);
  } catch (error) {
    Alert.alert("Export failed", error?.message || "The requisition PDF could not be saved. Please try again.");
  }
}

async function requestAndroidExportDirectoryAccess() {
  const downloadUri = FileSystem.StorageAccessFramework.getUriForDirectoryInRoot("Download");

  try {
    const preferredDirectory = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync(downloadUri);

    if (preferredDirectory.granted) {
      return preferredDirectory;
    }
  } catch (error) {
    console.log("Could not open the Download folder directly", error);
  }

  return await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
}

async function writePdfToSafDirectory(sourceUri, directoryUri, fileName) {
  const destinationUri = await FileSystem.StorageAccessFramework.createFileAsync(
    directoryUri,
    fileName.replace(/\.pdf$/i, ""),
    "application/pdf"
  );
  const pdfBase64 = await FileSystem.readAsStringAsync(sourceUri, {
    encoding: FileSystem.EncodingType.Base64
  });

  await FileSystem.StorageAccessFramework.writeAsStringAsync(destinationUri, pdfBase64, {
    encoding: FileSystem.EncodingType.Base64
  });

  return destinationUri;
}

function buildRequisitionPdfHtml(item, project = null) {
  const rows = [
    ["Project", getDisplayValue(project?.title, "Sample")],
    ["Project code", getDisplayValue(project?.projectCode, "SAMPLE")],
    ["Requisition ID", item.id],
    ["Item / Equipment", item.item],
    ["Category", getDisplayValue(item.category, "Unspecified")],
    ["Quantity", getDisplayValue(item.quantity, "Unspecified")],
    ["Needed date", getDisplayValue(item.neededDate)],
    ["Priority", getDisplayValue(item.priority, "Normal")],
    ["Requested by", getDisplayValue(item.requestedBy, "Unspecified")],
    ["Charge to", getDisplayValue(item.chargeTo, "Unspecified")],
    ["Manager status", getDisplayValue(item.status)],
    ["Procurement status", getDisplayValue(item.procurementStatus)],
    ["Delivery confirmation", getDisplayValue(item.deliveryConfirmation, "Not set")],
    ["Delivery remarks", getDisplayValue(item.deliveryRemarks, "None")],
    ["Notes", getDisplayValue(item.notes, "No additional notes.")]
  ];

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          * { box-sizing: border-box; }
          body {
            color: #111827;
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 36px;
          }
          .document {
            border: 1px solid #d1d5db;
            border-radius: 14px;
            overflow: hidden;
          }
          .header {
            background: #111827;
            color: #ffffff;
            padding: 28px;
          }
          .eyebrow {
            color: #cbd5e1;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 1.4px;
            margin: 0 0 8px;
            text-transform: uppercase;
          }
          h1 {
            font-size: 28px;
            margin: 0;
          }
          .meta {
            color: #e5e7eb;
            font-size: 13px;
            margin-top: 10px;
          }
          .content {
            padding: 28px;
          }
          .summary {
            background: #f8fafc;
            border: 1px solid #e5e7eb;
            border-radius: 12px;
            margin-bottom: 22px;
            padding: 18px;
          }
          .summary-title {
            font-size: 20px;
            font-weight: 800;
            margin: 0 0 8px;
          }
          .summary-subtitle {
            color: #64748b;
            font-size: 13px;
            margin: 0;
          }
          table {
            border-collapse: collapse;
            width: 100%;
          }
          th, td {
            border-bottom: 1px solid #e5e7eb;
            font-size: 13px;
            line-height: 1.45;
            padding: 13px 12px;
            text-align: left;
            vertical-align: top;
          }
          th {
            background: #f8fafc;
            color: #475569;
            font-size: 11px;
            letter-spacing: 0.4px;
            text-transform: uppercase;
            width: 32%;
          }
          td {
            color: #111827;
            font-weight: 700;
          }
          .footer {
            color: #64748b;
            font-size: 11px;
            margin-top: 22px;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="document">
          <div class="header">
            <p class="eyebrow">Material and Equipment Requisition</p>
            <h1>${escapeHtml(item.id || "Requisition")}</h1>
            <div class="meta">Generated on ${escapeHtml(new Date().toLocaleString())}</div>
          </div>
          <div class="content">
            <div class="summary">
              <p class="summary-title">${escapeHtml(getDisplayValue(item.item, "Unnamed request"))}</p>
              <p class="summary-subtitle">Prepared requisition copy for review, approval, and filing.</p>
            </div>
            <table>${rows.map(([label, value]) => buildPdfRow(label, value)).join("")}</table>
            <div class="footer">This exported PDF intentionally excludes status history.</div>
          </div>
        </div>
      </body>
    </html>
  `;
}

function buildAllRequisitionsPdfHtml(requisitions, project = null) {
  const title = project?.title ? `${project.title} Requisitions` : "All Requisitions";
  const projectDetails = [project?.projectCode, project?.locationSite].filter(Boolean).join(" - ");
  const rows = requisitions.map((item, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(getDisplayValue(item.id, "-"))}</td>
      <td>${escapeHtml(getDisplayValue(item.item, "-"))}</td>
      <td>${escapeHtml(getDisplayValue(item.category, "-"))}</td>
      <td>${escapeHtml(getDisplayValue(item.quantity, "-"))}</td>
      <td>${escapeHtml(getDisplayValue(item.neededDate, "-"))}</td>
      <td>${escapeHtml(getDisplayValue(item.priority, "-"))}</td>
      <td>${escapeHtml(getDisplayValue(item.requestedBy, "-"))}</td>
      <td>${escapeHtml(getDisplayValue(item.chargeTo, "-"))}</td>
      <td>${escapeHtml(getDisplayValue(item.status, "-"))}</td>
      <td>${escapeHtml(getDisplayValue(item.procurementStatus, "-"))}</td>
      <td>${escapeHtml(getDisplayValue(item.deliveryConfirmation, "-"))}</td>
      <td>${escapeHtml(getDisplayValue(item.deliveryRemarks, "-"))}</td>
      <td>${escapeHtml(getDisplayValue(item.notes, "-"))}</td>
    </tr>
  `).join("");

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          @page { size: A4 landscape; margin: 18px; }
          * { box-sizing: border-box; }
          body {
            color: #111827;
            font-family: Arial, sans-serif;
            margin: 0;
          }
          .header {
            border-bottom: 2px solid #111827;
            margin-bottom: 12px;
            padding-bottom: 10px;
          }
          .eyebrow {
            color: #64748b;
            font-size: 9px;
            font-weight: 700;
            letter-spacing: 1.2px;
            margin: 0 0 4px;
            text-transform: uppercase;
          }
          h1 {
            font-size: 20px;
            margin: 0;
          }
          .meta {
            color: #64748b;
            font-size: 9px;
            margin-top: 4px;
          }
          table {
            border-collapse: collapse;
            table-layout: fixed;
            width: 100%;
          }
          th, td {
            border: 1px solid #d1d5db;
            font-size: 7px;
            line-height: 1.25;
            padding: 5px 4px;
            text-align: left;
            vertical-align: top;
            word-wrap: break-word;
          }
          th {
            background: #111827;
            color: #ffffff;
            font-size: 6.5px;
            letter-spacing: 0.2px;
            text-transform: uppercase;
          }
          tbody tr:nth-child(even) td {
            background: #f8fafc;
          }
          .col-no { width: 3%; }
          .col-id { width: 8%; }
          .col-item { width: 13%; }
          .col-category { width: 8%; }
          .col-quantity { width: 6%; }
          .col-date { width: 8%; }
          .col-priority { width: 7%; }
          .col-requested { width: 10%; }
          .col-charge { width: 10%; }
          .col-status { width: 7%; }
          .col-proc { width: 8%; }
          .col-delivery { width: 8%; }
          .col-remarks { width: 9%; }
          .col-notes { width: 8%; }
          .empty {
            border: 1px solid #d1d5db;
            color: #64748b;
            font-size: 12px;
            padding: 18px;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <p class="eyebrow">Material and Equipment Requisition</p>
          <h1>${escapeHtml(title)}</h1>
          <div class="meta">
            Generated on ${escapeHtml(new Date().toLocaleString())} - ${requisitions.length} record(s)${projectDetails ? ` - ${escapeHtml(projectDetails)}` : ""}
          </div>
        </div>
        ${requisitions.length === 0 ? `
          <div class="empty">No requisitions available for export.</div>
        ` : `
          <table>
            <thead>
              <tr>
                <th class="col-no">#</th>
                <th class="col-id">ID</th>
                <th class="col-item">Item / Equipment</th>
                <th class="col-category">Category</th>
                <th class="col-quantity">Qty</th>
                <th class="col-date">Needed</th>
                <th class="col-priority">Priority</th>
                <th class="col-requested">Requested By</th>
                <th class="col-charge">Charge To</th>
                <th class="col-status">Manager Status</th>
                <th class="col-proc">Proc Status</th>
                <th class="col-delivery">Delivery</th>
                <th class="col-remarks">Remarks</th>
                <th class="col-notes">Notes</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        `}
      </body>
    </html>
  `;
}

function buildPrsFileName(item = null) {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();
  const requisitionNumber = getRequisitionNumber(item);
  return `PRS-${month}${year}-${requisitionNumber}.pdf`;
}

function getRequisitionNumber(item) {
  if (!item?.id) {
    return "ALL";
  }

  const match = /REQ-(\d+)/i.exec(item.id);
  return match ? match[1] : String(item.id).replace(/[^a-z0-9-]/gi, "");
}

function getSortValue(item) {
  const createdAt = item.createdAt ? new Date(item.createdAt).getTime() : NaN;

  if (!Number.isNaN(createdAt)) {
    return createdAt;
  }

  const match = /^REQ-(\d+)$/.exec(item.id || "");
  return match ? Number(match[1]) : 0;
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f7f8fb",
    paddingTop: Platform.OS === "android" ? StatusBar.currentHeight : 0
  },
  container: {
    flex: 1,
    backgroundColor: "#f7f8fb"
  },
  authShell: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 22
  },
  loginShell: {
    flex: 1,
    justifyContent: "center",
    padding: 22
  },
  kicker: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0,
    marginBottom: 6,
    textTransform: "uppercase"
  },
  title: {
    color: "#111827",
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: 0,
    marginBottom: 10
  },
  subtitle: {
    color: "#64748b",
    fontSize: 15,
    lineHeight: 22
  },
  roleGrid: {
    gap: 12,
    marginTop: 10
  },
  roleCard: {
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    padding: 18,
    shadowColor: "#111827",
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2
  },
  roleCardActive: {
    borderColor: "#2563eb",
    borderWidth: 2
  },
  iconBadge: {
    alignItems: "center",
    backgroundColor: "#eef2ff",
    borderRadius: 8,
    height: 42,
    justifyContent: "center",
    marginBottom: 14,
    width: 42
  },
  roleName: {
    color: "#111827",
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 4
  },
  roleDescription: {
    color: "#64748b",
    fontSize: 14,
    lineHeight: 20
  },
  loginPanel: {
    gap: 12,
    marginTop: 24
  },
  authTabs: {
    backgroundColor: "#e5e7eb",
    borderRadius: 8,
    flexDirection: "row",
    gap: 4,
    marginTop: 24,
    padding: 4
  },
  authTab: {
    alignItems: "center",
    borderRadius: 8,
    flex: 1,
    minHeight: 44,
    justifyContent: "center"
  },
  authTabActive: {
    backgroundColor: "#ffffff"
  },
  authTabText: {
    color: "#64748b",
    fontSize: 14,
    fontWeight: "800"
  },
  authTabTextActive: {
    color: "#111827"
  },
  sectionLabel: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  input: {
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    color: "#111827",
    fontSize: 15,
    minHeight: 52,
    paddingHorizontal: 16
  },
  twoColumn: {
    flexDirection: "row",
    gap: 10
  },
  flexInput: {
    flex: 1
  },
  codeRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10
  },
  codeInput: {
    flex: 1
  },
  dropdownButton: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    minHeight: 56,
    paddingHorizontal: 16
  },
  dropdownTextBlock: {
    flex: 1,
    gap: 2
  },
  dropdownValue: {
    color: "#111827",
    fontSize: 15,
    fontWeight: "800"
  },
  dropdownPlaceholder: {
    color: "#9ca3af",
    fontWeight: "600"
  },
  dropdownSubtext: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  textarea: {
    minHeight: 96,
    paddingTop: 14,
    textAlignVertical: "top"
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#111827",
    borderRadius: 8,
    flexDirection: "row",
    gap: 10,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 18
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "800"
  },
  disabledButton: {
    backgroundColor: "#64748b"
  },
  backButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: 8,
    marginBottom: 28,
    paddingVertical: 8
  },
  backText: {
    color: "#111827",
    fontSize: 14,
    fontWeight: "700"
  },
  dashboard: {
    padding: 18,
    paddingBottom: 34
  },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    justifyContent: "space-between",
    marginBottom: 18
  },
  headerTextBlock: {
    flex: 1,
    minWidth: 180,
    paddingRight: 4
  },
  dashboardTitle: {
    color: "#111827",
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: 0
  },
  headerActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  headerIconButton: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  statsRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 14
  },
  statCard: {
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    padding: 14
  },
  statValue: {
    color: "#111827",
    fontSize: 24,
    fontWeight: "800"
  },
  statLabel: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 2
  },
  toolbar: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 12
  },
  toolbarActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8
  },
  controlLabel: {
    color: "#475569",
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  controlSegments: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  controlSegment: {
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 36,
    paddingHorizontal: 11,
    justifyContent: "center"
  },
  controlSegmentActive: {
    backgroundColor: "#111827",
    borderColor: "#111827"
  },
  controlSegmentText: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "800"
  },
  controlSegmentTextActive: {
    color: "#ffffff"
  },
  searchBox: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    gap: 10,
    minHeight: 50,
    paddingHorizontal: 14
  },
  searchInput: {
    color: "#111827",
    flex: 1,
    fontSize: 15
  },
  addButton: {
    alignItems: "center",
    backgroundColor: "#2563eb",
    borderRadius: 8,
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    minHeight: 50,
    paddingHorizontal: 16
  },
  addButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800"
  },
  displayMenuButton: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    minHeight: 50,
    paddingHorizontal: 12
  },
  displayMenuButtonText: {
    color: "#111827",
    fontSize: 13,
    fontWeight: "800"
  },
  projectMenuButton: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 12
  },
  projectMenuButtonText: {
    color: "#111827",
    fontSize: 13,
    fontWeight: "800"
  },
  displayMenuSection: {
    gap: 8,
    marginBottom: 16
  },
  statusTabs: {
    gap: 8,
    paddingBottom: 12
  },
  statusTab: {
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 9
  },
  statusTabActive: {
    backgroundColor: "#111827",
    borderColor: "#111827"
  },
  statusTabText: {
    color: "#64748b",
    fontSize: 13,
    fontWeight: "700"
  },
  statusTabTextActive: {
    color: "#ffffff"
  },
  permissionBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 14
  },
  permissionChip: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  permissionChipAllowed: {
    backgroundColor: "#ecfdf5",
    borderColor: "#bbf7d0"
  },
  permissionText: {
    color: "#9ca3af",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "capitalize"
  },
  permissionTextAllowed: {
    color: "#047857"
  },
  list: {
    gap: 12
  },
  itemCard: {
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
    shadowColor: "#111827",
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2
  },
  itemCardCompact: {
    padding: 12
  },
  itemTop: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between"
  },
  itemTitleBlock: {
    flex: 1
  },
  itemId: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 3
  },
  itemName: {
    color: "#111827",
    fontSize: 19,
    fontWeight: "800",
    lineHeight: 24
  },
  itemNameCompact: {
    fontSize: 15,
    lineHeight: 20
  },
  cardStatusStack: {
    alignItems: "flex-end",
    flexShrink: 1,
    flexDirection: "column",
    gap: 6,
    maxWidth: "48%"
  },
  statusPill: {
    alignSelf: "flex-end",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  statusPillText: {
    color: "#111827",
    fontSize: 12,
    fontWeight: "800"
  },
  statusGreen: {
    backgroundColor: "#dcfce7"
  },
  statusRed: {
    backgroundColor: "#fee2e2"
  },
  statusBlue: {
    backgroundColor: "#dbeafe"
  },
  statusAmber: {
    backgroundColor: "#fef3c7"
  },
  statusNeutral: {
    backgroundColor: "#f3f4f6"
  },
  procurementPill: {
    backgroundColor: "#e0f2fe"
  },
  deliveryPill: {
    backgroundColor: "#ede9fe"
  },
  detailsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 14
  },
  detailsGridTight: {
    marginTop: 8
  },
  detail: {
    backgroundColor: "#f8fafc",
    borderRadius: 8,
    minWidth: "47%",
    padding: 10
  },
  detailLabel: {
    color: "#64748b",
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 2
  },
  detailValue: {
    color: "#111827",
    fontSize: 14,
    fontWeight: "800"
  },
  detailRow: {
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
    padding: 12
  },
  detailRowLabel: {
    color: "#64748b",
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  detailRowValue: {
    color: "#111827",
    fontSize: 15,
    fontWeight: "800",
    lineHeight: 21
  },
  detailHero: {
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    marginBottom: 12,
    padding: 16
  },
  detailHeroTitle: {
    color: "#111827",
    fontSize: 22,
    fontWeight: "800",
    lineHeight: 28
  },
  detailStatusRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  detailSection: {
    gap: 10,
    marginBottom: 12
  },
  detailSectionTitle: {
    color: "#111827",
    fontSize: 16,
    fontWeight: "800"
  },
  detailNotes: {
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    color: "#475569",
    fontSize: 14,
    lineHeight: 21,
    padding: 12
  },
  detailActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 12
  },
  modalTitleBlock: {
    flex: 1,
    paddingRight: 12
  },
  notes: {
    color: "#475569",
    fontSize: 14,
    lineHeight: 20,
    marginTop: 12
  },
  requestedBy: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 8
  },
  historyBlock: {
    backgroundColor: "#f8fafc",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    marginTop: 12,
    padding: 12
  },
  historyTitle: {
    color: "#111827",
    fontSize: 13,
    fontWeight: "800"
  },
  historyEmpty: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  historyRow: {
    flexDirection: "row",
    gap: 8
  },
  historyDot: {
    backgroundColor: "#2563eb",
    borderRadius: 4,
    height: 8,
    marginTop: 5,
    width: 8
  },
  historyTextBlock: {
    flex: 1,
    gap: 2
  },
  historyAction: {
    color: "#111827",
    fontSize: 12,
    fontWeight: "800"
  },
  historyDetails: {
    color: "#475569",
    fontSize: 12,
    lineHeight: 17
  },
  historyDate: {
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: "700"
  },
  detailHistoryList: {
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
    padding: 12
  },
  cardActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 14
  },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 7,
    minHeight: 40,
    paddingHorizontal: 12
  },
  secondaryButtonText: {
    color: "#111827",
    fontSize: 13,
    fontWeight: "800"
  },
  dangerButton: {
    alignItems: "center",
    backgroundColor: "#fff1f2",
    borderColor: "#fecdd3",
    borderRadius: 8,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    width: 44
  },
  emptyState: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    padding: 28
  },
  emptyTitle: {
    color: "#111827",
    fontSize: 17,
    fontWeight: "800",
    marginTop: 10
  },
  emptyText: {
    color: "#64748b",
    fontSize: 14,
    marginTop: 4
  },
  modalOverlay: {
    backgroundColor: "rgba(17, 24, 39, 0.36)",
    flex: 1,
    justifyContent: "flex-end"
  },
  modalPanel: {
    backgroundColor: "#f7f8fb",
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    maxHeight: "90%",
    padding: 18
  },
  dropdownOverlay: {
    backgroundColor: "rgba(17, 24, 39, 0.36)",
    flex: 1,
    justifyContent: "center",
    padding: 18
  },
  dropdownPanel: {
    backgroundColor: "#f7f8fb",
    borderRadius: 8,
    maxHeight: "80%",
    padding: 18
  },
  dropdownHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 14
  },
  calendarHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 14
  },
  calendarTitle: {
    color: "#111827",
    flex: 1,
    fontSize: 18,
    fontWeight: "800",
    textAlign: "center"
  },
  weekdayRow: {
    flexDirection: "row",
    marginBottom: 8
  },
  weekdayText: {
    color: "#64748b",
    flex: 1,
    fontSize: 11,
    fontWeight: "800",
    textAlign: "center"
  },
  calendarGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 14
  },
  calendarDay: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    width: "14.28%"
  },
  calendarDayMuted: {
    opacity: 0.42
  },
  calendarDayActive: {
    backgroundColor: "#111827",
    borderColor: "#111827"
  },
  calendarDayText: {
    color: "#111827",
    fontSize: 13,
    fontWeight: "800"
  },
  calendarDayTextActive: {
    color: "#ffffff"
  },
  managerList: {
    gap: 10
  },
  projectMenuList: {
    marginBottom: 14,
    maxHeight: 320
  },
  managerOption: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    minHeight: 62,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  managerOptionActive: {
    backgroundColor: "#ecfdf5",
    borderColor: "#bbf7d0"
  },
  managerOptionText: {
    flex: 1,
    gap: 3
  },
  managerName: {
    color: "#111827",
    fontSize: 15,
    fontWeight: "800"
  },
  managerEmail: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  modalHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 14
  },
  modalTitle: {
    color: "#111827",
    fontSize: 24,
    fontWeight: "800"
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    width: 42
  },
  segmented: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginVertical: 12
  },
  formStack: {
    gap: 12,
    paddingBottom: 12
  },
  segment: {
    backgroundColor: "#ffffff",
    borderColor: "#e5e7eb",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 10
  },
  segmentActive: {
    backgroundColor: "#111827",
    borderColor: "#111827"
  },
  segmentText: {
    color: "#64748b",
    fontSize: 13,
    fontWeight: "800"
  },
  segmentTextActive: {
    color: "#ffffff"
  },
  hovered: {
    borderColor: "#93c5fd",
    transform: [{ translateY: -1 }]
  },
  pressed: {
    opacity: 0.82,
    transform: [{ scale: 0.99 }]
  },
  disabledControl: {
    opacity: 0.72
  }
});
